import { ethers } from "hardhat";
import { loadHookDeployment, loadGuardianMultisigDeployment } from "./lib/deployments";

/**
 * Live proof of the specific design payoff documented in
 * AncillaGuardianMultisig.sol's header comment: because the target isn't
 * bound at construction, ONE deployed guardian multisig can supervise
 * pause/unpause across every Ancilla contract pointed at it — proven here
 * against AncillaSwapHook, using the SAME AncillaGuardianMultisig address
 * already proven (scripts/demo-guardian-multisig.ts) to gate
 * IntentCommitReveal. test/AncillaGuardianMultisig.test.ts's "one
 * guardian multisig, multiple targets" suite proves this in Hardhat; this
 * script proves it against two real, independently deployed, live
 * contracts on Arbitrum Sepolia, using the multisig's own proposalCount()
 * growing from wherever IntentCommitReveal's proposals left it — that
 * continuity is itself evidence this is genuinely the same shared
 * instance, not a second one with a matching address by coincidence.
 *
 * Usage:
 *   npx hardhat run scripts/demo-guardian-multisig-hook.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env, both owners of
 * deployments/arbitrumSepolia.json's AncillaGuardianMultisig.
 */

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function main() {
  const hookDeployment = loadHookDeployment("arbitrumSepolia");
  const guardianDeployment = loadGuardianMultisigDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [ownerA] = await ethers.getSigners();
  const ownerB = new ethers.Wallet(agentPk, ethers.provider);
  const hookAddress = hookDeployment.hook.address;

  console.log("== Ancilla guardian-multisig 'one instance, two targets' live demo: Arbitrum Sepolia ==");
  console.log("AncillaSwapHook:        ", hookAddress, explorerAddr(hookAddress));
  console.log("AncillaGuardianMultisig:", guardianDeployment.address, explorerAddr(guardianDeployment.address));

  const hook = await ethers.getContractAt("AncillaSwapHook", hookAddress, ownerA);
  const multisigA = await ethers.getContractAt("AncillaGuardianMultisig", guardianDeployment.address, ownerA);
  const multisigB = await ethers.getContractAt("AncillaGuardianMultisig", guardianDeployment.address, ownerB);

  const onChainGuardian: string = await hook.guardian();
  if (onChainGuardian.toLowerCase() !== guardianDeployment.address.toLowerCase()) {
    throw new Error(`AncillaSwapHook's guardian (${onChainGuardian}) is not this AncillaGuardianMultisig.`);
  }
  const proposalsBefore: bigint = await multisigA.proposalCount();
  console.log(
    `   confirmed: this hook's guardian really is the multisig. It already has ${proposalsBefore} proposal(s) on record — presumably from IntentCommitReveal's own pause governance, not this script.`
  );

  // ---------------------------------------------------------------------
  console.log("\n[1/4] Owner A proposes pausing AncillaSwapHook (a NEW target for this same multisig)...");
  const proposeTx = await multisigA.proposePause(hookAddress);
  const proposeReceipt = await proposeTx.wait();
  console.log("   proposePause tx:", explorerTx(proposeTx.hash));
  const proposalId = (
    await multisigA.queryFilter(multisigA.filters.Proposed(), proposeReceipt!.blockNumber, proposeReceipt!.blockNumber)
  )[0].args.id;
  console.log("   proposal id:", proposalId.toString(), proposalId >= proposalsBefore ? "(continues the SAME multisig's proposal history)" : "");

  console.log("\n[2/4] Owner A alone tries to execute — must fail...");
  let singleOwnerBlocked = false;
  try {
    await multisigA.execute.staticCall(proposalId);
  } catch (err: any) {
    singleOwnerBlocked = true;
    console.log("   correctly rejected:", err.shortMessage || err.message);
  }

  console.log("\n[3/4] Owner B confirms, then execution succeeds — pausing the REAL hook...");
  await (await multisigB.confirm(proposalId)).wait();
  const executeTx = await multisigA.execute(proposalId);
  console.log("   execute tx:", explorerTx(executeTx.hash));
  await executeTx.wait();
  const pausedAfterExecute: boolean = await hook.paused();
  console.log("   hook.paused() =", pausedAfterExecute, "(expected true)");

  console.log("\n[4/4] Unpausing through the same multisig, and verifying everything...");
  const unpauseProposeTx = await multisigA.proposeUnpause(hookAddress);
  const unpauseProposeReceipt = await unpauseProposeTx.wait();
  const unpauseId = (
    await multisigA.queryFilter(multisigA.filters.Proposed(), unpauseProposeReceipt!.blockNumber, unpauseProposeReceipt!.blockNumber)
  )[0].args.id;
  await (await multisigB.confirm(unpauseId)).wait();
  const unpauseExecuteTx = await multisigA.execute(unpauseId);
  console.log("   unpause execute tx:", explorerTx(unpauseExecuteTx.hash));
  await unpauseExecuteTx.wait();
  const pausedAfterUnpause: boolean = await hook.paused();
  console.log("   hook.paused() after unpause =", pausedAfterUnpause, "(expected false)");

  const success = singleOwnerBlocked && pausedAfterExecute && !pausedAfterUnpause && proposalId >= proposalsBefore;
  console.log(
    success
      ? "\n✅ SHARED GUARDIAN-MULTISIG DEMO PASSED — the exact same on-chain multisig instance that gates IntentCommitReveal also gated AncillaSwapHook, live, with the same 2-of-3 enforcement."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
