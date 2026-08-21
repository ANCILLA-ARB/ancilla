import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { mineHookAddress, HookFlags } from "./lib/hookMiner";
import { loadSwapStackDeployment, loadTreasuryMultisigDeployment, loadGuardianMultisigDeployment } from "./lib/deployments";

/**
 * Deploys the "Option A" v4 architecture — AncillaSwapHook,
 * AncillaHookRouter, and AncillaLiquidityRouter — against a REAL, already
 * live Uniswap v4 PoolManager (Uniswap deploys and operates this; Ancilla
 * never deploys or modifies it). Reuses the same aUSD/aETH tokens already
 * live from scripts/deploy-swap.ts, and wires both `treasury` and
 * `guardian` straight to the already-deployed, already-proven-live
 * AncillaTreasuryMultisig / AncillaGuardianMultisig (the SAME guardian
 * multisig instance that already supervises IntentCommitReveal — see
 * AncillaGuardianMultisig.sol's header for why one instance can guard
 * multiple targets).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-hook.ts --network arbitrumSepolia
 *
 * Requires deployments/<network>.json to already have TestTokenA/
 * TestTokenB (scripts/deploy-swap.ts), AncillaTreasuryMultisig
 * (scripts/deploy-treasury.ts), and AncillaGuardianMultisig
 * (scripts/deploy-guardian.ts) populated.
 */

const COMMIT_WINDOW_SECONDS = 120;
const REVEAL_DELAY_SECONDS = 30;
const REVEAL_WINDOW_SECONDS = 120;
const MIN_BOND = ethers.parseEther("0.001");
const FEE = 3000; // 0.3%, matches AncillaSwapPool's fee tier
const TICK_SPACING = 60;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2^96 — standard "1:1 price" constant

// Verified live via docs.uniswap.org/contracts/v4/deployments (chain id
// 421614 = Arbitrum Sepolia) — Ancilla never deploys this itself.
const UNISWAP_V4_POOL_MANAGER = "0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const swapStack = loadSwapStackDeployment("arbitrumSepolia");
  const treasuryMultisig = loadTreasuryMultisigDeployment("arbitrumSepolia");
  const guardianMultisig = loadGuardianMultisigDeployment("arbitrumSepolia");
  console.log("Reusing TestTokenA (aUSD):", swapStack.tokenA);
  console.log("Reusing TestTokenB (aETH):", swapStack.tokenB);
  console.log("Treasury (AncillaTreasuryMultisig):", treasuryMultisig.address);
  console.log("Guardian (AncillaGuardianMultisig):", guardianMultisig.address);
  console.log("Uniswap v4 PoolManager (live, not ours):", UNISWAP_V4_POOL_MANAGER);

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Deploying Create2Factory (needed to mine a hook address)...");
  const Factory = await ethers.getContractFactory("Create2Factory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log("   Create2Factory:", factoryAddress);

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Mining a hook address encoding {beforeSwap, afterSwap}...");
  // Reuses the SAME AncillaGuardianMultisig instance already wired into
  // IntentCommitReveal.guardian — that contract deliberately doesn't bind
  // to a single target at construction (see its header comment) so one
  // guardian multisig can supervise pause/unpause across every Ancilla
  // contract, not just one. Pausing only ever blocks new commitIntent
  // calls; reveal-and-swap keeps working even while paused.
  const guardian = guardianMultisig.address;
  // Same 10% default as deploy.ts — see AncillaSwapHook.sol's header
  // comment ("ECONOMIC HARDENING").
  const SLASHER_REWARD_BPS = 1000;

  const HookFactory = await ethers.getContractFactory("AncillaSwapHook");
  const constructorArgsEncoded = HookFactory.interface.encodeDeploy([
    UNISWAP_V4_POOL_MANAGER,
    COMMIT_WINDOW_SECONDS,
    REVEAL_DELAY_SECONDS,
    REVEAL_WINDOW_SECONDS,
    MIN_BOND,
    treasuryMultisig.address,
    guardian,
    SLASHER_REWARD_BPS,
  ]);
  const flags = HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
  const mined = mineHookAddress(factoryAddress, flags, HookFactory.bytecode, constructorArgsEncoded);
  console.log("   mined address:", mined.address, " salt:", mined.salt);

  const deployTx = await factory.deploy(mined.salt, mined.initCode);
  await deployTx.wait();
  console.log("   AncillaSwapHook deployed at:", mined.address, "tx:", deployTx.hash);

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Deploying AncillaHookRouter + AncillaLiquidityRouter...");
  const Router = await ethers.getContractFactory("AncillaHookRouter");
  const router = await Router.deploy(UNISWAP_V4_POOL_MANAGER);
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log("   AncillaHookRouter:", routerAddress);

  const LiquidityRouter = await ethers.getContractFactory("AncillaLiquidityRouter");
  const liquidityRouter = await LiquidityRouter.deploy(UNISWAP_V4_POOL_MANAGER);
  await liquidityRouter.waitForDeployment();
  const liquidityRouterAddress = await liquidityRouter.getAddress();
  console.log("   AncillaLiquidityRouter:", liquidityRouterAddress);

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Building the pool key and initializing the pool...");
  const [addrA, addrB] = [swapStack.tokenA, swapStack.tokenB];
  const [currency0, currency1] = BigInt(addrA) < BigInt(addrB) ? [addrA, addrB] : [addrB, addrA];
  const key = { currency0, currency1, fee: FEE, tickSpacing: TICK_SPACING, hooks: mined.address };

  const poolManager = await ethers.getContractAt("IPoolManager", UNISWAP_V4_POOL_MANAGER);
  const initTx = await poolManager.initialize(key, SQRT_PRICE_1_1);
  await initTx.wait();
  console.log("   pool initialized, tx:", initTx.hash);

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Seeding real liquidity via AncillaLiquidityRouter...");
  const MathHelper = await ethers.getContractFactory("V4TestMath");
  const mathHelper = await MathHelper.deploy();
  await mathHelper.waitForDeployment();
  const tickLower = await mathHelper.minUsableTick(TICK_SPACING);
  const tickUpper = await mathHelper.maxUsableTick(TICK_SPACING);
  const sqrtPriceA = await mathHelper.getSqrtPriceAtTick(tickLower);
  const sqrtPriceB = await mathHelper.getSqrtPriceAtTick(tickUpper);

  const seedAmount = ethers.parseUnits("1000", 18); // modest — testnet demo liquidity, not real TVL
  const liquidity = await mathHelper.getLiquidityForAmounts(
    SQRT_PRICE_1_1,
    sqrtPriceA,
    sqrtPriceB,
    seedAmount,
    seedAmount
  );

  const tokenA = await ethers.getContractAt("TestToken", swapStack.tokenA);
  const tokenB = await ethers.getContractAt("TestToken", swapStack.tokenB);
  await (await tokenA.mint(deployer.address, seedAmount)).wait();
  await (await tokenB.mint(deployer.address, seedAmount)).wait();
  await (await tokenA.approve(liquidityRouterAddress, seedAmount)).wait();
  await (await tokenB.approve(liquidityRouterAddress, seedAmount)).wait();

  const addLiqTx = await liquidityRouter.addLiquidity(key, {
    tickLower,
    tickUpper,
    liquidityDelta: liquidity,
    salt: ethers.ZeroHash,
  });
  await addLiqTx.wait();
  console.log("   liquidity added, tx:", addLiqTx.hash);

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Writing to deployments file...");
  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  let existing: any = { network: network.name, contracts: {} };
  if (fs.existsSync(deploymentsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    } catch {
      // corrupt or unreadable — start fresh rather than crash the deploy
    }
  }
  existing.network = network.name;
  existing.chainId = Number((await ethers.provider.getNetwork()).chainId);
  existing.contracts = existing.contracts || {};
  existing.contracts.UniswapV4PoolManager = {
    address: UNISWAP_V4_POOL_MANAGER,
    note: "Deployed and operated by Uniswap, not by this repo. Verified via docs.uniswap.org/contracts/v4/deployments.",
  };
  existing.contracts.Create2Factory = { address: factoryAddress };
  existing.contracts.AncillaSwapHook = {
    address: mined.address,
    salt: mined.salt,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    commitWindowSeconds: COMMIT_WINDOW_SECONDS,
    revealDelaySeconds: REVEAL_DELAY_SECONDS,
    revealWindowSeconds: REVEAL_WINDOW_SECONDS,
    minBond: MIN_BOND.toString(),
    treasury: treasuryMultisig.address,
    guardian,
    slasherRewardBps: SLASHER_REWARD_BPS,
  };
  existing.contracts.AncillaHookRouter = { address: routerAddress };
  existing.contracts.AncillaLiquidityRouter = { address: liquidityRouterAddress };
  existing.contracts.AncillaHookPool = {
    currency0,
    currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: mined.address,
  };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
