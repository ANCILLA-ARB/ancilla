import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * End-to-end demo against a LIVE deployed IntentCommitReveal contract.
 *
 * This is not a unit test against a local Hardhat network — every step here
 * is a real transaction on Arbitrum Sepolia, waited for and verified by
 * re-reading on-chain state afterwards. It exists to prove the deployed
 * contract behaves correctly outside of the test sandbox.
 *
 * Usage:
 *   npx hardhat run scripts/demo.ts --network arbitrumSepolia
 *
 * Requires:
 *   - PRIVATE_KEY in .env, funded with a small amount of Arbitrum Sepolia ETH
 *   - deployments/arbitrumSepolia.json pointing at an already-deployed
 *     IntentCommitReveal (see scripts/deploy.ts)
 */

const INTENT_CONTRACT_ADDRESS = loadIntentCommitRevealDeployment("arbitrumSepolia").address;

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

/** Poll real wall-clock chain time (block.timestamp, via the latest block)
 *  until it reaches `target`. Deliberately NOT using block number — see
 *  IntentCommitReveal.sol's header comment on why Arbitrum's in-contract
 *  block.number does not match what off-chain tooling reports. */
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
  const [signer] = await ethers.getSigners();
  console.log("== Ancilla live demo: Arbitrum Sepolia ==");
  console.log("Signer:", signer.address);

  const contract = await ethers.getContractAt("IntentCommitReveal", INTENT_CONTRACT_ADDRESS, signer);
  console.log("Target contract:", INTENT_CONTRACT_ADDRESS, explorerAddr(INTENT_CONTRACT_ADDRESS));

  // ---------------------------------------------------------------------
  console.log("\n[1/5] Deploying a fresh MockExecutor to receive the revealed intent...");
  const ExecutorFactory = await ethers.getContractFactory("MockExecutor");
  const executor = await ExecutorFactory.deploy();
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();
  console.log("   MockExecutor deployed:", executorAddress, explorerAddr(executorAddress));

  // ---------------------------------------------------------------------
  console.log("\n[2/5] Checking bond / depositing if needed...");
  const minBond: bigint = await contract.minBond();
  let bond: bigint = await contract.bondBalance(signer.address);
  console.log(`   minBond required: ${ethers.formatEther(minBond)} ETH, current bond: ${ethers.formatEther(bond)} ETH`);
  if (bond < minBond) {
    const need = minBond - bond;
    const tx = await contract.depositBond({ value: need });
    console.log("   depositBond tx sent:", explorerTx(tx.hash));
    await tx.wait();
    bond = await contract.bondBalance(signer.address);
    console.log("   confirmed. New bond balance:", ethers.formatEther(bond), "ETH");
  } else {
    console.log("   already sufficiently bonded, skipping deposit.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[3/5] Committing an intent...");
  const nonce = Date.now(); // unique per run
  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string"],
    [`ancilla-demo:${nonce}`]
  );
  const built = buildIntent(signer.address, intentData, nonce);
  console.log("   commitId:  ", built.commitId);
  console.log("   commitHash:", built.commitHash);

  const commitTx = await contract.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx sent:", explorerTx(commitTx.hash));
  const commitReceipt = await commitTx.wait();
  console.log("   confirmed in block", commitReceipt!.blockNumber);

  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  const closeTime: bigint = await contract.revealCloseTimeOf(epoch);
  console.log(`   epoch ${epoch} — reveal window: [${openTime}, ${closeTime}) (unix seconds)`);

  // ---------------------------------------------------------------------
  console.log("\n[4/5] Waiting for the shared reveal window to open (this is the real batching delay, not simulated)...");
  await waitForTimestamp(openTime, "reveal opens");

  console.log("\n   Revealing intent...");
  const revealTx = await contract.revealIntent(built.commitId, built.intentData, built.salt, executorAddress);
  console.log("   revealIntent tx sent:", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();
  console.log("   confirmed in block", revealReceipt!.blockNumber);

  // ---------------------------------------------------------------------
  console.log("\n[5/5] Independently re-reading on-chain state to verify (not trusting the tx receipt alone)...");
  const stored = await contract.commitments(built.commitId);
  console.log("   commitments(commitId).revealed =", stored.revealed);

  const executedFilter = executor.filters.Executed();
  const executedEvents = await executor.queryFilter(executedFilter, revealReceipt!.blockNumber, revealReceipt!.blockNumber);
  console.log("   MockExecutor 'Executed' events in that block:", executedEvents.length);
  if (executedEvents.length > 0) {
    const ev = executedEvents[0];
    console.log("     agent:", ev.args?.agent);
    console.log("     intentData:", ev.args?.intentData);
  }

  const revealedFilter = contract.filters.IntentRevealed(built.commitId);
  const revealedEvents = await contract.queryFilter(revealedFilter, revealReceipt!.blockNumber, revealReceipt!.blockNumber);
  console.log("   IntentCommitReveal 'IntentRevealed' events found:", revealedEvents.length);

  const success = stored.revealed === true && executedEvents.length === 1 && revealedEvents.length === 1;
  console.log(success ? "\n✅ DEMO PASSED — full commit-reveal-execute cycle verified live on Arbitrum Sepolia." : "\n❌ DEMO FAILED — see output above.");
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
