import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { signRevealRequest } from "../sdk/relay";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * Live demo of the relayed-reveal path (Phase 3, partial) on Arbitrum
 * Sepolia. Uses TWO distinct wallets to prove the actual privacy property:
 *
 *   AGENT_PRIVATE_KEY  — commits the intent AND signs the reveal
 *                        authorization off-chain. Never submits the reveal
 *                        transaction itself.
 *   PRIVATE_KEY        — plays the "relay": submits revealIntentViaRelay(),
 *                        pays its own gas, and is msg.sender on-chain — a
 *                        completely different address from the agent.
 *
 * What this proves, verified independently after the fact (not just
 * trusting the script's own narration):
 *   - the on-chain transaction sender for the reveal is the RELAY address
 *   - the emitted IntentRevealed event still correctly attributes the
 *     intent to the AGENT address, and records the relay separately
 *   - MockExecutor received the AGENT's address as the executing party,
 *     not the relay's
 *
 * Usage:
 *   npx hardhat run scripts/demo-relay.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY both set in .env, both funded
 * with a small amount of Arbitrum Sepolia ETH.
 */

const INTENT_CONTRACT_ADDRESS = loadIntentCommitRevealDeployment("arbitrumSepolia").address;

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
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [relay] = await ethers.getSigners(); // from PRIVATE_KEY
  const agent = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla relayed-reveal demo: Arbitrum Sepolia ==");
  console.log("Agent wallet (commits + signs):", agent.address);
  console.log("Relay wallet (submits + pays gas):", relay.address);
  if (agent.address.toLowerCase() === relay.address.toLowerCase()) {
    throw new Error("Agent and relay must be different wallets — that's the whole point of this demo.");
  }

  const contract = await ethers.getContractAt("IntentCommitReveal", INTENT_CONTRACT_ADDRESS, relay);
  const contractAsAgent = contract.connect(agent);
  console.log("Target contract:", INTENT_CONTRACT_ADDRESS, explorerAddr(INTENT_CONTRACT_ADDRESS));

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Deploying a fresh MockExecutor (relay pays for this one)...");
  const ExecutorFactory = await ethers.getContractFactory("MockExecutor", relay);
  const executor = await ExecutorFactory.deploy();
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();
  console.log("   MockExecutor deployed:", executorAddress, explorerAddr(executorAddress));

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Agent checks/deposits its own bond (agent pays its own gas here)...");
  const minBond: bigint = await contract.minBond();
  let bond: bigint = await contract.bondBalance(agent.address);
  console.log(`   minBond: ${ethers.formatEther(minBond)} ETH, agent's current bond: ${ethers.formatEther(bond)} ETH`);
  if (bond < minBond) {
    const tx = await contractAsAgent.depositBond({ value: minBond - bond });
    console.log("   depositBond tx (agent):", explorerTx(tx.hash));
    await tx.wait();
  } else {
    console.log("   already bonded, skipping.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Agent commits the intent (agent pays its own gas here)...");
  const nonce = Date.now();
  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [`ancilla-relay-demo:${nonce}`]);
  const built = buildIntent(agent.address, intentData, nonce);
  const commitTx = await contractAsAgent.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx (agent):", explorerTx(commitTx.hash));
  await commitTx.wait();

  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  const closeTime: bigint = await contract.revealCloseTimeOf(epoch);
  console.log(`   epoch ${epoch} — reveal window: [${openTime}, ${closeTime})`);

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Agent SIGNS a reveal authorization off-chain (no transaction, no gas)...");
  const network = await ethers.provider.getNetwork();
  const { value, signature } = await signRevealRequest(
    agent,
    network.chainId,
    INTENT_CONTRACT_ADDRESS,
    built.commitId,
    built.intentData,
    built.salt,
    executorAddress,
    600
  );
  console.log("   signed RevealRequest, deadline:", value.deadline.toString());
  console.log("   signature:", signature);

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Waiting for the reveal window, then RELAY submits the reveal (relay pays gas, not agent)...");
  await waitForTimestamp(openTime, "reveal opens");

  const relayTx = await contract.revealIntentViaRelay(
    built.commitId,
    built.intentData,
    built.salt,
    executorAddress,
    agent.address,
    value.deadline,
    signature
  );
  console.log("   revealIntentViaRelay tx (sent by RELAY):", explorerTx(relayTx.hash));
  const relayReceipt = await relayTx.wait();
  console.log("   confirmed in block", relayReceipt!.blockNumber, "— tx.from was:", relayReceipt!.from);

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Independently re-reading on-chain state to verify the attribution split...");
  const stored = await contract.commitments(built.commitId);
  console.log("   commitments(commitId).revealed =", stored.revealed);
  console.log("   commitments(commitId).agent    =", stored.agent, stored.agent.toLowerCase() === agent.address.toLowerCase() ? "(matches agent ✓)" : "(MISMATCH ✗)");

  const revealedEvents = await contract.queryFilter(
    contract.filters.IntentRevealed(built.commitId),
    relayReceipt!.blockNumber,
    relayReceipt!.blockNumber
  );
  const executedEvents = await executor.queryFilter(
    executor.filters.Executed(),
    relayReceipt!.blockNumber,
    relayReceipt!.blockNumber
  );

  let eventChecksPassed = false;
  if (revealedEvents.length === 1 && executedEvents.length === 1) {
    const ev = revealedEvents[0];
    console.log("   IntentRevealed.agent   =", ev.args?.agent, ev.args?.agent === agent.address ? "✓" : "✗ MISMATCH");
    console.log("   IntentRevealed.relayer =", ev.args?.relayer, ev.args?.relayer === relay.address ? "✓ (matches relay wallet, NOT agent)" : "✗ MISMATCH");
    const executedAgent = executedEvents[0].args?.agent;
    console.log("   MockExecutor.Executed.agent =", executedAgent, executedAgent === agent.address ? "✓ (executor saw the AGENT, not the relay)" : "✗ MISMATCH");

    eventChecksPassed =
      stored.revealed === true &&
      ev.args?.agent === agent.address &&
      ev.args?.relayer === relay.address &&
      executedAgent === agent.address &&
      relayReceipt!.from.toLowerCase() === relay.address.toLowerCase();
  } else {
    console.log("   Expected exactly 1 IntentRevealed and 1 Executed event, found:", revealedEvents.length, executedEvents.length);
  }

  console.log(
    eventChecksPassed
      ? "\n✅ RELAY DEMO PASSED — tx sender was the relay, but on-chain state and events correctly attribute the intent to the agent, verified independently."
      : "\n❌ RELAY DEMO FAILED — see output above."
  );
  if (!eventChecksPassed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
