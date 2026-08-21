import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * Live proof for the emergency-pause mechanism added to IntentCommitReveal
 * (and, identically, AncillaSwapHook — proven there via
 * test/AncillaSwapHook.test.ts's "emergency pause" suite instead of a
 * second live script, since the underlying mechanism is the same standard
 * OpenZeppelin Pausable logic in both places).
 *
 * Proves, against the real deployed contract, both halves of the design:
 *   1. Once paused, a brand-new commitIntent() reverts.
 *   2. A commitment made BEFORE the pause can still be revealed WHILE
 *      still paused — pausing blocks new exposure, it never traps an
 *      agent's already-locked bond or already-submitted intent.
 *
 * Usage:
 *   npx hardhat run scripts/demo-pause.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY in .env, and that wallet to be this deployment's
 * `guardian` (true for the current deployments/arbitrumSepolia.json entry
 * — deploy.ts sets guardian = deployer for now, see its own comment on why).
 */

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

async function main() {
  const deployment = loadIntentCommitRevealDeployment("arbitrumSepolia");
  const [guardian] = await ethers.getSigners();

  console.log("== Ancilla emergency-pause live demo: Arbitrum Sepolia ==");
  console.log("IntentCommitReveal:", deployment.address, explorerAddr(deployment.address));
  console.log("Guardian wallet:   ", guardian.address);

  const contract = await ethers.getContractAt("IntentCommitReveal", deployment.address, guardian);
  const onChainGuardian: string = await contract.guardian();
  if (onChainGuardian.toLowerCase() !== guardian.address.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY's wallet (${guardian.address}) is not this deployment's guardian (${onChainGuardian}) — can't pause.`
    );
  }

  const Executor = await ethers.getContractFactory("MockExecutor", guardian);
  const executor = await Executor.deploy();
  await executor.waitForDeployment();
  console.log("Deployed a throwaway MockExecutor for this demo:", await executor.getAddress());

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Bonding and committing an intent — before any pause...");
  const minBond = BigInt(deployment.minBond);
  const lockedBond: bigint = await contract.lockedBond(guardian.address);
  const currentBond: bigint = await contract.bondBalance(guardian.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await contract.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["pause demo intent"]);
  const built = buildIntent(guardian.address, intentData, Date.now());
  const commitTx = await contract.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();

  const commitment = await contract.commitments(built.commitId);
  const openTime = await contract.revealOpenTimeOf(commitment.epoch);

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Pausing the contract...");
  const pauseTx = await contract.pause();
  console.log("   pause tx:", explorerTx(pauseTx.hash));
  await pauseTx.wait();
  const pausedAfterPause: boolean = await contract.paused();
  console.log("   paused() =", pausedAfterPause, "(expected true)");

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Confirming a brand-new commit is rejected while paused...");
  const built2 = buildIntent(guardian.address, intentData, Date.now() + 1);
  let newCommitRejected = false;
  try {
    await contract.commitIntent.staticCall(built2.commitId, built2.commitHash);
  } catch (err: any) {
    newCommitRejected = true;
    console.log("   correctly rejected:", err.shortMessage || err.message);
  }

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Waiting for the reveal window of the PRE-pause commitment...");
  await waitForTimestamp(openTime, "reveal opens");

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Revealing the pre-pause commitment WHILE STILL PAUSED...");
  const stillPaused: boolean = await contract.paused();
  console.log("   paused() =", stillPaused, "(still true — nothing unpaused it)");
  const revealTx = await contract.revealIntent(built.commitId, intentData, built.salt, await executor.getAddress());
  console.log("   revealIntent tx:", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Unpausing, and verifying everything independently...");
  const unpauseTx = await contract.unpause();
  console.log("   unpause tx:", explorerTx(unpauseTx.hash));
  await unpauseTx.wait();
  const pausedAfterUnpause: boolean = await contract.paused();

  const resolved = await contract.commitments(built.commitId);
  const revealedEvents = await contract.queryFilter(
    contract.filters.IntentRevealed(),
    revealReceipt!.blockNumber,
    revealReceipt!.blockNumber
  );

  console.log("   commitments(commitId).revealed =", resolved.revealed);
  console.log("   paused() after unpause =", pausedAfterUnpause, "(expected false)");
  console.log("   IntentRevealed events found:", revealedEvents.length);

  const success =
    pausedAfterPause === true &&
    newCommitRejected === true &&
    resolved.revealed === true &&
    pausedAfterUnpause === false &&
    revealedEvents.length === 1;

  console.log(
    success
      ? "\n✅ PAUSE DEMO PASSED — a new commit was rejected while paused, and a commitment made before the pause was still revealed successfully while still paused, live on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
