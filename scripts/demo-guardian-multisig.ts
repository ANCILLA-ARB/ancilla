import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment, loadGuardianMultisigDeployment } from "./lib/deployments";

/**
 * Live proof that AncillaGuardianMultisig — not a single EOA — actually
 * gates pause()/unpause() on the real deployed IntentCommitReveal.
 *
 * Extends scripts/demo-pause.ts's proof (new commit rejected while paused;
 * a pre-pause commitment still reveals successfully while still paused)
 * with the property that specifically motivated replacing a single-EOA
 * guardian: one owner proposing is NOT enough — execution must fail until
 * a second, independent owner also confirms. That's the actual security
 * upgrade over deploy.ts's previous `guardian = deployer.address`; proving
 * it live (not just in test/AncillaGuardianMultisig.test.ts) means showing
 * a real single-confirmation execute() attempt really does revert
 * on-chain, not just asserting it would.
 *
 * Usage:
 *   npx hardhat run scripts/demo-guardian-multisig.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env, and both wallets to
 * be owners of deployments/arbitrumSepolia.json's AncillaGuardianMultisig
 * (true for GUARDIAN_MULTISIG_OWNERS as configured — see .env.example).
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
  const guardianDeployment = loadGuardianMultisigDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [ownerA] = await ethers.getSigners(); // from PRIVATE_KEY
  const ownerB = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla guardian-multisig pause governance live demo: Arbitrum Sepolia ==");
  console.log("IntentCommitReveal:     ", deployment.address, explorerAddr(deployment.address));
  console.log("AncillaGuardianMultisig:", guardianDeployment.address, explorerAddr(guardianDeployment.address));
  console.log("Owner A (proposer):     ", ownerA.address);
  console.log("Owner B (2nd confirmer):", ownerB.address);

  const target = await ethers.getContractAt("IntentCommitReveal", deployment.address, ownerA);
  const multisigA = await ethers.getContractAt("AncillaGuardianMultisig", guardianDeployment.address, ownerA);
  const multisigB = await ethers.getContractAt("AncillaGuardianMultisig", guardianDeployment.address, ownerB);

  const onChainGuardian: string = await target.guardian();
  if (onChainGuardian.toLowerCase() !== guardianDeployment.address.toLowerCase()) {
    throw new Error(
      `This IntentCommitReveal's guardian (${onChainGuardian}) is not the AncillaGuardianMultisig in deployments/arbitrumSepolia.json (${guardianDeployment.address}).`
    );
  }
  if (!(await multisigA.isOwner(ownerA.address))) throw new Error(`${ownerA.address} is not a guardian-multisig owner`);
  if (!(await multisigA.isOwner(ownerB.address))) throw new Error(`${ownerB.address} is not a guardian-multisig owner`);
  console.log("   confirmed: this deployment's guardian really is the multisig, and both wallets are real owners.");

  const Executor = await ethers.getContractFactory("MockExecutor", ownerA);
  const executor = await Executor.deploy();
  await executor.waitForDeployment();
  console.log("Deployed a throwaway MockExecutor for this demo:", await executor.getAddress());

  // ---------------------------------------------------------------------
  console.log("\n[1/8] Bonding and committing an intent — before any pause...");
  const minBond = BigInt(deployment.minBond);
  const lockedBond: bigint = await target.lockedBond(ownerA.address);
  const currentBond: bigint = await target.bondBalance(ownerA.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await target.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  }
  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["guardian-multisig demo intent"]);
  const built = buildIntent(ownerA.address, intentData, Date.now());
  const commitTx = await target.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();
  const commitment = await target.commitments(built.commitId);
  const openTime = await target.revealOpenTimeOf(commitment.epoch);

  // ---------------------------------------------------------------------
  console.log("\n[2/8] Owner A proposes pausing IntentCommitReveal (this is also A's confirmation)...");
  const proposeTx = await multisigA.proposePause(deployment.address);
  console.log("   proposePause tx:", explorerTx(proposeTx.hash));
  const proposeReceipt = await proposeTx.wait();
  const proposedEvent = (await multisigA.queryFilter(multisigA.filters.Proposed(), proposeReceipt!.blockNumber, proposeReceipt!.blockNumber))[0];
  const proposalId = proposedEvent.args.id;
  console.log("   proposal id:", proposalId.toString());

  // ---------------------------------------------------------------------
  console.log("\n[3/8] Owner A ALONE tries to execute — this must fail, proving 1 confirmation isn't enough...");
  let singleOwnerBlocked = false;
  try {
    await multisigA.execute.staticCall(proposalId);
  } catch (err: any) {
    singleOwnerBlocked = true;
    console.log("   correctly rejected:", err.shortMessage || err.message);
  }
  const stillUnpaused: boolean = await target.paused();
  console.log("   target.paused() =", stillUnpaused, "(expected false — nothing executed yet)");

  // ---------------------------------------------------------------------
  console.log("\n[4/8] Owner B independently confirms the same proposal...");
  const confirmTx = await multisigB.confirm(proposalId);
  console.log("   confirm tx:", explorerTx(confirmTx.hash));
  await confirmTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[5/8] NOW executing, with 2-of-3 confirmations reached...");
  const executeTx = await multisigA.execute(proposalId);
  console.log("   execute tx:", explorerTx(executeTx.hash));
  await executeTx.wait();
  const pausedAfterExecute: boolean = await target.paused();
  console.log("   target.paused() =", pausedAfterExecute, "(expected true)");

  // ---------------------------------------------------------------------
  console.log("\n[6/8] Confirming a brand-new commit is rejected while paused, and pre-pause reveal still works...");
  const built2 = buildIntent(ownerA.address, intentData, Date.now() + 1);
  let newCommitRejected = false;
  try {
    await target.commitIntent.staticCall(built2.commitId, built2.commitHash);
  } catch (err: any) {
    newCommitRejected = true;
    console.log("   new commit correctly rejected:", err.shortMessage || err.message);
  }
  await waitForTimestamp(openTime, "reveal opens");
  const revealTx = await target.revealIntent(built.commitId, intentData, built.salt, await executor.getAddress());
  console.log("   revealIntent tx (while still paused):", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[7/8] Unpausing through the multisig too (propose -> confirm -> execute)...");
  const unpauseProposeTx = await multisigA.proposeUnpause(deployment.address);
  const unpauseProposeReceipt = await unpauseProposeTx.wait();
  const unpauseProposalId = (
    await multisigA.queryFilter(multisigA.filters.Proposed(), unpauseProposeReceipt!.blockNumber, unpauseProposeReceipt!.blockNumber)
  )[0].args.id;
  await (await multisigB.confirm(unpauseProposalId)).wait();
  const unpauseExecuteTx = await multisigA.execute(unpauseProposalId);
  console.log("   unpause execute tx:", explorerTx(unpauseExecuteTx.hash));
  await unpauseExecuteTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[8/8] Independently verifying everything...");
  const pausedAfterUnpause: boolean = await target.paused();
  const resolved = await target.commitments(built.commitId);
  const revealedEvents = await target.queryFilter(
    target.filters.IntentRevealed(),
    revealReceipt!.blockNumber,
    revealReceipt!.blockNumber
  );
  console.log("   target.paused() after unpause =", pausedAfterUnpause, "(expected false)");
  console.log("   commitments(commitId).revealed =", resolved.revealed);
  console.log("   IntentRevealed events found:", revealedEvents.length);

  const success =
    singleOwnerBlocked === true &&
    pausedAfterExecute === true &&
    newCommitRejected === true &&
    resolved.revealed === true &&
    pausedAfterUnpause === false &&
    revealedEvents.length === 1;

  console.log(
    success
      ? "\n✅ GUARDIAN-MULTISIG DEMO PASSED — a lone owner could not pause or unpause; two independent confirmations, live on Arbitrum Sepolia, were required and did."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
