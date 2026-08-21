import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadHookDeployment } from "./lib/deployments";

/**
 * Live proof for the "Option A" v4 architecture: AncillaSwapHook absorbing
 * commit-reveal entirely, gating a REAL Uniswap v4 pool instead of the
 * standalone AncillaSwapPool (scripts/demo-swap.ts proves that older path
 * separately — this script doesn't replace it, it proves the new one).
 *
 * Unlike demo-swap.ts, there is no separate "reveal" transaction here —
 * revealing IS the swap. The agent calls AncillaHookRouter.revealAndSwap
 * once, and inside that single transaction: AncillaSwapHook's beforeSwap
 * checks the hash commitment + timing window + that the swap params
 * actually match what was committed to, the real v4 swap executes against
 * real pooled liquidity, then afterSwap enforces the committed
 * minAmountOut against the real output and emits IntentSwapExecuted.
 *
 * Usage:
 *   npx hardhat run scripts/demo-hook-swap.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env, and
 * deployments/arbitrumSepolia.json populated by deploy.ts, deploy-swap.ts,
 * deploy-treasury.ts, and deploy-hook.ts (in that order).
 */

// Same verified sentinel values as test/AncillaSwapHook.test.ts.
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function waitForTimestamp(target: bigint, label: string) {
  process.stdout.write(`   waiting for timestamp ${target} (${label})`);
  for (;;) {
    const latest = await ethers.provider.getBlock("latest");
    const current = BigInt(latest!.timestamp);
    if (current >= target) {
      console.log(` — reached (current: ${current})`);
      return;
    }
    const remaining = target - current;
    process.stdout.write(` [${remaining}s left]`);
    await new Promise((r) => setTimeout(r, Math.min(15000, Number(remaining) * 1000 + 1000)));
  }
}

function encodeIntentData(tokenIn: string, amountIn: bigint, minAmountOut: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256"],
    [tokenIn, amountIn, minAmountOut]
  );
}

async function main() {
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const deployment = loadHookDeployment("arbitrumSepolia");
  const [lp] = await ethers.getSigners();
  const agent = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla v4-hook live demo: Arbitrum Sepolia (Option A architecture) ==");
  console.log("Agent wallet:  ", agent.address);
  console.log("PoolManager (Uniswap's, not ours):", deployment.poolManager, explorerAddr(deployment.poolManager));
  console.log("AncillaSwapHook:  ", deployment.hook.address, explorerAddr(deployment.hook.address));
  console.log("AncillaHookRouter:", deployment.router, explorerAddr(deployment.router));

  const hook = await ethers.getContractAt("AncillaSwapHook", deployment.hook.address, agent);
  const router = await ethers.getContractAt("AncillaHookRouter", deployment.router, agent);
  const key = deployment.poolKey;

  const tokenInAddr = key.currency0; // aETH is currency0 in this pool (see deployments file) — swap aETH -> aUSD
  const tokenOutAddr = key.currency1;
  const tokenIn = await ethers.getContractAt("TestToken", tokenInAddr, agent);
  const tokenOut = await ethers.getContractAt("TestToken", tokenOutAddr, agent);

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Making sure the agent wallet has enough ETH for its own gas...");
  const agentEthBal = await ethers.provider.getBalance(agent.address);
  console.log("   agent ETH balance:", ethers.formatEther(agentEthBal));
  if (agentEthBal < ethers.parseEther("0.0015")) {
    const topUp = ethers.parseEther("0.002");
    const tx = await lp.sendTransaction({ to: agent.address, value: topUp });
    console.log("   topping up agent with", ethers.formatEther(topUp), "ETH, tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Agent obtains tokenIn to swap, and bonds in AncillaSwapHook...");
  const amountIn = ethers.parseUnits("0.5", 18);
  await (await tokenIn.mint(agent.address, amountIn)).wait();
  console.log("   minted", ethers.formatUnits(amountIn, 18), "of tokenIn to agent");

  const minBond = BigInt(deployment.hook.minBond);
  const lockedBond: bigint = await hook.lockedBond(agent.address);
  const currentBond: bigint = await hook.bondBalance(agent.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await hook.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  } else {
    console.log("   already sufficiently bonded.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Agent approves the router, and commits the swap intent...");
  await (await tokenIn.approve(deployment.router, amountIn)).wait();
  console.log("   approved AncillaHookRouter for", ethers.formatUnits(amountIn, 18), "tokenIn");

  const minAmountOut = 1n; // demo pool has thin liquidity — this is about proving the mechanism, not a real quote
  const intentData = encodeIntentData(tokenInAddr, amountIn, minAmountOut);
  const nonce = Date.now();
  const built = buildIntent(agent.address, intentData, nonce);
  console.log("   commitId:", built.commitId, "(only this hash is visible on-chain right now)");

  const commitTx = await hook.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();

  const commitment = await hook.commitments(built.commitId);
  const openTime = await hook.revealOpenTimeOf(commitment.epoch);
  const closeTime = await hook.revealCloseTimeOf(commitment.epoch);
  console.log(`   epoch ${commitment.epoch} — reveal window: [${openTime}, ${closeTime}) (unix seconds)`);

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Waiting for the shared batch reveal window to open...");
  await waitForTimestamp(openTime, "reveal opens");

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Reveal-and-swap — this single transaction both reveals the intent AND executes the real v4 swap...");
  const zeroForOne = tokenInAddr.toLowerCase() === key.currency0.toLowerCase();
  const params = {
    zeroForOne,
    amountSpecified: -amountIn,
    sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
  };

  // Balance DELTA, not absolute balance — the agent wallet is reused across
  // this repo's demos, so it may already hold some tokenIn/tokenOut from an
  // earlier run. Assuming "after" must be exactly 0/higher-than-zero in
  // absolute terms would be a verification bug, not a protocol one — the
  // thing actually worth proving is that *exactly* amountIn moved.
  const tokenInBalBefore: bigint = await tokenIn.balanceOf(agent.address);
  const tokenOutBalBefore: bigint = await tokenOut.balanceOf(agent.address);
  const revealTx = await router.revealAndSwap(key, params, built.commitId, intentData, built.salt);
  console.log("   revealAndSwap tx:", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();
  console.log("   confirmed in block", revealReceipt!.blockNumber);

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Independently verifying the swap actually happened, on-chain...");
  const tokenInBalAfter: bigint = await tokenIn.balanceOf(agent.address);
  const tokenOutBalAfter: bigint = await tokenOut.balanceOf(agent.address);
  const resolved = await hook.commitments(built.commitId);

  const executedEvents = await hook.queryFilter(
    hook.filters.IntentSwapExecuted(),
    revealReceipt!.blockNumber,
    revealReceipt!.blockNumber
  );

  const tokenInSpent = tokenInBalBefore - tokenInBalAfter;
  const tokenOutReceived = tokenOutBalAfter - tokenOutBalBefore;
  console.log(
    "   agent tokenIn spent:",
    ethers.formatUnits(tokenInSpent, 18),
    "(expected exactly", ethers.formatUnits(amountIn, 18), ")"
  );
  console.log("   agent tokenOut received:", ethers.formatUnits(tokenOutReceived, 18), "(expected > 0)");
  console.log("   commitments(commitId).revealed =", resolved.revealed);
  console.log("   lockedBond(agent) =", (await hook.lockedBond(agent.address)).toString(), "(expected 0)");
  console.log("   AncillaSwapHook 'IntentSwapExecuted' events found:", executedEvents.length);

  const success =
    resolved.revealed === true &&
    tokenInSpent === amountIn &&
    tokenOutReceived > 0n &&
    executedEvents.length === 1;

  console.log(
    success
      ? "\n✅ V4 HOOK DEMO PASSED — a privacy-preserving intent was committed, then revealed AND executed as a real Uniswap v4 swap in one transaction, gated entirely by AncillaSwapHook, live on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
