import { ethers } from "hardhat";
import { loadTokenStackDeployment } from "./lib/deployments";

/**
 * Live proof of the full AncillaGovernor lifecycle on Arbitrum Sepolia:
 * propose -> vote -> queue -> wait out the real timelock delay -> execute
 * -> verify the mint actually happened, independently, via balance delta.
 *
 * Also proves the handoff itself is real and one-way: once
 * AncillaToken.owner() is the timelock, a direct mint() call from the
 * wallet that used to be owner is confirmed to fail.
 *
 * Re-runnable: on a first run it mints a small demo allocation to two
 * voters and hands ownership to the DAO; on later runs (ownership
 * already transferred) it skips straight to a fresh proposal, using
 * whatever voting power those two wallets already have delegated.
 *
 * Usage:
 *   npx hardhat run scripts/demo-governor.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env, both used as the
 * two demo voters.
 */

const DEMO_MINT_PER_VOTER = ethers.parseEther("1000"); // demo voting power, not tokenomics
const PROPOSAL_MINT_AMOUNT = ethers.parseEther("50");
const FOR = 1;

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

// AncillaToken's voting clock runs on real block.timestamp, not block
// number (see AncillaToken.sol's clock() override) — so proposalSnapshot
// / proposalDeadline are unix timestamps here, not block numbers. This
// polls the chain's own latest block timestamp, not Date.now(), so it
// matches exactly what the contract itself will check.
async function waitForTimestamp(target: bigint, label: string) {
  process.stdout.write(`   waiting for timestamp ${target} (${label})`);
  for (;;) {
    const latest = await ethers.provider.getBlock("latest");
    const current = BigInt(latest!.timestamp);
    if (current >= target) {
      console.log(` — reached (current: ${current})`);
      return;
    }
    process.stdout.write(` [${target - current}s left]`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

async function main() {
  const stack = loadTokenStackDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [deployer] = await ethers.getSigners();
  const agent = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla governance live demo: Arbitrum Sepolia ==");
  console.log("AncillaToken:    ", stack.token, explorerAddr(stack.token));
  console.log("AncillaTimelock: ", stack.timelock, explorerAddr(stack.timelock));
  console.log("AncillaGovernor: ", stack.governor, explorerAddr(stack.governor));
  console.log("Voter A:         ", deployer.address);
  console.log("Voter B:         ", agent.address);

  const token = await ethers.getContractAt("AncillaToken", stack.token, deployer);
  const governor = await ethers.getContractAt("AncillaGovernor", stack.governor, deployer);

  // ---------------------------------------------------------------------
  const currentOwner: string = await token.owner();
  if (currentOwner.toLowerCase() === deployer.address.toLowerCase()) {
    console.log("\n[setup] First run — minting demo voting power and handing minting to the DAO...");
    await (await token.mint(deployer.address, DEMO_MINT_PER_VOTER)).wait();
    await (await token.mint(agent.address, DEMO_MINT_PER_VOTER)).wait();
    await (await token.delegate(deployer.address)).wait();
    await (await token.connect(agent).delegate(agent.address)).wait();
    const transferTx = await token.transferOwnership(stack.timelock);
    console.log("   transferOwnership tx:", explorerTx(transferTx.hash));
    await transferTx.wait();
  } else if (currentOwner.toLowerCase() !== stack.timelock.toLowerCase()) {
    throw new Error(`AncillaToken.owner() is neither the deployer nor the timelock (${currentOwner}) — unexpected state.`);
  } else {
    console.log("\n[setup] Already handed to the DAO — reusing existing voting power for a fresh proposal.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Proposing a mint through the DAO...");
  const nonce = Date.now();
  const calldata = token.interface.encodeFunctionData("mint", [deployer.address, PROPOSAL_MINT_AMOUNT]);
  const description = `Live demo mint #${nonce}: ${ethers.formatEther(PROPOSAL_MINT_AMOUNT)} ANCILLA to ${deployer.address}`;
  const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));
  const proposeTx = await governor.propose([stack.token], [0], [calldata], description);
  console.log("   propose tx:", explorerTx(proposeTx.hash));
  const proposeReceipt = await proposeTx.wait();
  const proposedEvent = proposeReceipt!.logs
    .map((l) => { try { return governor.interface.parseLog(l as any); } catch { return null; } })
    .find((e) => e && e.name === "ProposalCreated");
  const proposalId = (proposedEvent as any).args.proposalId;
  console.log("   proposal id:", proposalId.toString());

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Waiting for the voting delay to pass...");
  const snapshot: bigint = await governor.proposalSnapshot(proposalId);
  await waitForTimestamp(snapshot + 1n, "voting opens");

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Both voters cast a real vote FOR...");
  const voteTxA = await governor.castVote(proposalId, FOR);
  console.log("   voter A castVote tx:", explorerTx(voteTxA.hash));
  await voteTxA.wait();
  const voteTxB = await governor.connect(agent).castVote(proposalId, FOR);
  console.log("   voter B castVote tx:", explorerTx(voteTxB.hash));
  await voteTxB.wait();

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Waiting for the voting period to close...");
  const deadline: bigint = await governor.proposalDeadline(proposalId);
  await waitForTimestamp(deadline + 1n, "voting closes");
  const stateAfterVoting = await governor.state(proposalId);
  console.log("   proposal state after voting:", stateAfterVoting.toString(), "(4 = Succeeded)");

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Queuing, then waiting out the real timelock delay...");
  const queueTx = await governor.queue([stack.token], [0], [calldata], descriptionHash);
  console.log("   queue tx:", explorerTx(queueTx.hash));
  await queueTx.wait();
  const eta: bigint = await governor.proposalEta(proposalId);
  console.log(`   proposal executable at unix ${eta} — waiting in real time...`);
  for (;;) {
    const latestBlock = await ethers.provider.getBlock("latest");
    if (BigInt(latestBlock!.timestamp) >= eta) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(" ready");

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Executing, and verifying independently via balance delta...");
  const before: bigint = await token.balanceOf(deployer.address);
  const executeTx = await governor.execute([stack.token], [0], [calldata], descriptionHash);
  console.log("   execute tx:", explorerTx(executeTx.hash));
  await executeTx.wait();
  const after: bigint = await token.balanceOf(deployer.address);
  const minted = after - before;
  console.log(`   balance delta: ${ethers.formatEther(minted)} ANCILLA (expected ${ethers.formatEther(PROPOSAL_MINT_AMOUNT)})`);

  let directMintBlocked = false;
  try {
    await token.mint.staticCall(deployer.address, 1n);
  } catch (err: any) {
    directMintBlocked = true;
    console.log("   confirmed: a DIRECT mint() call (bypassing governance) now reverts:", err.shortMessage || err.message);
  }

  const success = minted === PROPOSAL_MINT_AMOUNT && directMintBlocked;
  console.log(
    success
      ? "\n✅ GOVERNANCE DEMO PASSED — a real proposal was voted on, queued, survived the real timelock delay, and executed live on Arbitrum Sepolia. Minting only works through the DAO now."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
