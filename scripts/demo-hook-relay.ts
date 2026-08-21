import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { signCommitRequest } from "../sdk/relay";
import { loadHookDeployment } from "./lib/deployments";

/**
 * Live proof of AncillaSwapHook.commitIntentViaRelay on Arbitrum Sepolia —
 * the same relayed-commit mechanism already proven for IntentCommitReveal
 * (scripts/demo-relay.ts), now ported to the hook too. Uses two distinct
 * wallets to prove the actual attribution property, not just that the
 * call succeeds:
 *
 *   AGENT_PRIVATE_KEY — signs the CommitRequest off-chain. Never submits
 *                       the commit transaction itself.
 *   PRIVATE_KEY       — plays the relay: submits commitIntentViaRelay(),
 *                       pays gas, is msg.sender on-chain.
 *
 * After the relayed commit lands, the agent reveals-and-swaps directly
 * themselves — no relay path exists for that half, see
 * AncillaSwapHook.sol's header comment for why — proving the relayed
 * commitment is fully usable afterward, not just recorded. This half is
 * deliberately copied close to verbatim from scripts/demo-hook-swap.ts's
 * already-proven revealAndSwap call shape, not reinvented.
 *
 * Usage:
 *   npx hardhat run scripts/demo-hook-relay.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env.
 */

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
  return ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256", "uint256"], [tokenIn, amountIn, minAmountOut]);
}

async function main() {
  const deployment = loadHookDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [relay] = await ethers.getSigners(); // from PRIVATE_KEY — plays the relay here
  const agent = new ethers.Wallet(agentPk, ethers.provider);
  const key = deployment.poolKey;

  console.log("== Ancilla hook relayed-commit live demo: Arbitrum Sepolia ==");
  console.log("AncillaSwapHook:  ", deployment.hook.address, explorerAddr(deployment.hook.address));
  console.log("Relay (submits commit tx):", relay.address);
  console.log("Agent (signs only):       ", agent.address);

  const hookAsAgent = await ethers.getContractAt("AncillaSwapHook", deployment.hook.address, agent);
  const hookAsRelay = await ethers.getContractAt("AncillaSwapHook", deployment.hook.address, relay);
  const router = await ethers.getContractAt("AncillaHookRouter", deployment.router, agent);

  const tokenInAddr = key.currency0; // aETH is currency0 in this pool — same as demo-hook-swap.ts
  const tokenOutAddr = key.currency1;
  const tokenIn = await ethers.getContractAt("TestToken", tokenInAddr, agent);
  const tokenOut = await ethers.getContractAt("TestToken", tokenOutAddr, agent);

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Making sure the agent wallet has enough ETH for its own gas...");
  const agentEthBal = await ethers.provider.getBalance(agent.address);
  if (agentEthBal < ethers.parseEther("0.0015")) {
    const topUp = ethers.parseEther("0.002");
    const tx = await relay.sendTransaction({ to: agent.address, value: topUp });
    console.log("   topping up agent, tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Agent obtains tokenIn, approves the router, and ensures enough bond...");
  const amountIn = ethers.parseUnits("0.5", 18);
  await (await tokenIn.mint(agent.address, amountIn)).wait();
  await (await tokenIn.approve(deployment.router, amountIn)).wait();

  const minBond = BigInt(deployment.hook.minBond);
  const lockedBond: bigint = await hookAsAgent.lockedBond(agent.address);
  const currentBond: bigint = await hookAsAgent.bondBalance(agent.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await hookAsAgent.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Agent signs a CommitRequest off-chain; the RELAY submits commitIntentViaRelay...");
  const minAmountOut = 1n;
  const intentData = encodeIntentData(tokenInAddr, amountIn, minAmountOut);
  const nonce = Date.now();
  const built = buildIntent(agent.address, intentData, nonce);
  const network = await ethers.provider.getNetwork();
  const commitReq = await signCommitRequest(
    agent,
    network.chainId,
    deployment.hook.address,
    built.commitId,
    built.commitHash,
    3600
  );

  const commitTx = await hookAsRelay.commitIntentViaRelay(
    built.commitId,
    built.commitHash,
    agent.address,
    commitReq.value.deadline,
    commitReq.signature
  );
  console.log("   commitIntentViaRelay tx (submitted by the RELAY, not the agent):", explorerTx(commitTx.hash));
  await commitTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Independently verifying the commitment landed attributed to the AGENT, not the relay...");
  const stored = await hookAsAgent.commitments(built.commitId);
  console.log("   commitments(commitId).agent =", stored.agent, stored.agent === agent.address ? "✓" : "✗ MISMATCH");
  if (stored.agent !== agent.address) throw new Error("commit not correctly attributed to agent");
  const openTime = await hookAsAgent.revealOpenTimeOf(stored.epoch);

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Waiting for the reveal window, then the agent reveals-and-swaps directly (no relay path for this half)...");
  await waitForTimestamp(openTime, "reveal opens");

  const zeroForOne = tokenInAddr.toLowerCase() === key.currency0.toLowerCase();
  const params = {
    zeroForOne,
    amountSpecified: -amountIn,
    sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
  };

  const tokenInBalBefore: bigint = await tokenIn.balanceOf(agent.address);
  const tokenOutBalBefore: bigint = await tokenOut.balanceOf(agent.address);
  const revealTx = await router.revealAndSwap(key, params, built.commitId, intentData, built.salt);
  console.log("   revealAndSwap tx (agent's own wallet — commit was relayed, this half wasn't):", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Independently verifying the swap actually happened, on-chain...");
  const tokenInBalAfter: bigint = await tokenIn.balanceOf(agent.address);
  const tokenOutBalAfter: bigint = await tokenOut.balanceOf(agent.address);
  const resolved = await hookAsAgent.commitments(built.commitId);
  const events = await hookAsAgent.queryFilter(
    hookAsAgent.filters.IntentSwapExecuted(),
    revealReceipt!.blockNumber,
    revealReceipt!.blockNumber
  );

  const tokenInSpent = tokenInBalBefore - tokenInBalAfter;
  const tokenOutReceived = tokenOutBalAfter - tokenOutBalBefore;
  console.log("   agent tokenIn spent:", ethers.formatUnits(tokenInSpent, 18), "(expected exactly", ethers.formatUnits(amountIn, 18), ")");
  console.log("   agent tokenOut received:", ethers.formatUnits(tokenOutReceived, 18), "(expected > 0)");
  console.log("   commitments(commitId).revealed =", resolved.revealed);
  console.log("   IntentSwapExecuted events found:", events.length);

  const success = resolved.revealed === true && tokenInSpent === amountIn && tokenOutReceived > 0n && events.length === 1;
  console.log(
    success
      ? "\n✅ HOOK RELAY DEMO PASSED — the relay submitted the commit and paid its gas, the agent's own signature authorized it, the commitment was correctly attributed and fully usable through a real swap afterward, live on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
