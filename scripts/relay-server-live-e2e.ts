import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { signCommitRequest, signRevealRequest } from "../sdk/relay";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * End-to-end proof against the REAL, publicly hosted relay-server (Railway
 * or wherever RELAY_URL points), not a local ts-node/Hardhat-network
 * instance — the live counterpart to scripts/relay-server-e2e.ts. Talks to
 * the relay purely over HTTPS, exactly the way a real agent client would;
 * never touches the contract directly except to independently verify the
 * outcome afterward.
 *
 * Usage:
 *   RELAY_URL=https://<your-deployment>.up.railway.app \
 *     npx hardhat run scripts/relay-server-live-e2e.ts --network arbitrumSepolia
 *
 * Requires AGENT_PRIVATE_KEY in .env (a wallet DIFFERENT from whatever
 * RELAY_PRIVATE_KEY the hosted relay itself uses), and
 * deployments/arbitrumSepolia.json populated with IntentCommitReveal
 * (deploy.ts) and MockExecutor (deploy-mock-executor.ts).
 */

const RELAY_URL = process.env.RELAY_URL;

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!RELAY_URL) throw new Error("RELAY_URL not set — e.g. RELAY_URL=https://your-app.up.railway.app");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const deployment = loadIntentCommitRevealDeployment("arbitrumSepolia");
  const mockExecutorAddress: string | undefined = (() => {
    const fs = require("fs");
    const path = require("path");
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "arbitrumSepolia.json"), "utf8"));
    return data?.contracts?.MockExecutor?.address;
  })();
  if (!mockExecutorAddress) {
    throw new Error("No MockExecutor in deployments/arbitrumSepolia.json — run scripts/deploy-mock-executor.ts first");
  }

  const agent = new ethers.Wallet(agentPk, ethers.provider);
  console.log("== Ancilla LIVE relay-server E2E: real HTTPS deployment, real Arbitrum Sepolia ==");
  console.log("Relay URL:         ", RELAY_URL);
  console.log("IntentCommitReveal:", deployment.address);
  console.log("MockExecutor:      ", mockExecutorAddress);
  console.log("Agent wallet:      ", agent.address);

  const contract = await ethers.getContractAt("IntentCommitReveal", deployment.address, agent);

  const health = await fetch(`${RELAY_URL}/health`).then((r) => r.json());
  console.log("Relay server health:", health);
  if (health.relay?.toLowerCase() === agent.address.toLowerCase()) {
    throw new Error("Relay and agent must be different wallets");
  }
  if (health.contract?.toLowerCase() !== deployment.address.toLowerCase()) {
    throw new Error(`Relay is pointed at a different contract (${health.contract}) than expected (${deployment.address})`);
  }

  // ---------------------------------------------------------------------
  console.log("\n[1/5] Agent ensures it has enough free bond (direct call, not relayed)...");
  const minBond: bigint = await contract.minBond();
  const bal: bigint = await contract.bondBalance(agent.address);
  const locked: bigint = await contract.lockedBond(agent.address);
  const needed = locked + minBond;
  if (bal < needed) {
    const tx = await contract.depositBond({ value: needed - bal });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  } else {
    console.log("   already sufficiently bonded:", ethers.formatEther(bal), "ETH");
  }

  // ---------------------------------------------------------------------
  console.log("\n[2/5] Agent signs a CommitRequest and POSTs it to the hosted relay's /commit...");
  const nonce = Date.now();
  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [`relay-server-live-e2e:${nonce}`]);
  const built = buildIntent(agent.address, intentData, nonce);
  const network = await ethers.provider.getNetwork();

  const commitReq = await signCommitRequest(agent, network.chainId, deployment.address, built.commitId, built.commitHash, 3600);

  const commitRes = await fetch(`${RELAY_URL}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commitId: built.commitId,
      commitHash: built.commitHash,
      agent: agent.address,
      deadline: commitReq.value.deadline.toString(),
      signature: commitReq.signature,
    }),
  }).then((r) => r.json());
  console.log("   relay responded:", commitRes);
  if (!commitRes.ok) throw new Error("commit relay failed: " + JSON.stringify(commitRes));
  console.log("   tx (submitted by the RELAY wallet, not the agent):", explorerTx(commitRes.txHash));

  // ---------------------------------------------------------------------
  console.log("\n[3/5] Independently verifying the commit landed on-chain, attributed to the agent...");
  const storedAfterCommit = await contract.commitments(built.commitId);
  console.log(
    "   commitments(commitId).agent =",
    storedAfterCommit.agent,
    storedAfterCommit.agent === agent.address ? "✓" : "✗ MISMATCH"
  );
  if (storedAfterCommit.agent !== agent.address) throw new Error("commit not correctly attributed to agent");

  // ---------------------------------------------------------------------
  console.log("\n[4/5] Agent signs a RevealRequest and POSTs it to /reveal — well before the window opens...");
  const revealReq = await signRevealRequest(
    agent,
    network.chainId,
    deployment.address,
    built.commitId,
    built.intentData,
    built.salt,
    mockExecutorAddress,
    3600
  );
  const revealRes = await fetch(`${RELAY_URL}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commitId: built.commitId,
      intentData: built.intentData,
      salt: built.salt,
      executor: mockExecutorAddress,
      agent: agent.address,
      deadline: revealReq.value.deadline.toString(),
      signature: revealReq.signature,
    }),
  }).then((r) => r.json());
  console.log("   relay accepted (queued):", revealRes);

  // ---------------------------------------------------------------------
  console.log("\n[5/5] Polling GET /status until the hosted relay's background worker confirms it on-chain...");
  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  const closeTime: bigint = await contract.revealCloseTimeOf(epoch);
  console.log(`   epoch ${epoch} — reveal window: [${openTime}, ${closeTime}) (unix seconds), relay polls every 5s`);

  let finalStatus: any = null;
  for (let i = 0; i < 60; i++) {
    const status = await fetch(`${RELAY_URL}/status/${built.commitId}`).then((r) => r.json());
    process.stdout.write(` [${status.status}]`);
    if (status.status === "confirmed" || status.status === "failed" || status.status === "expired") {
      finalStatus = status;
      break;
    }
    await sleep(5000);
  }
  console.log("\n   final status from hosted relay:", finalStatus);
  if (finalStatus?.txHash) console.log("   tx:", explorerTx(finalStatus.txHash));

  const storedFinal = await contract.commitments(built.commitId);
  const success = finalStatus?.status === "confirmed" && storedFinal.revealed === true;
  console.log(
    success
      ? "\n✅ LIVE RELAY-SERVER E2E PASSED — commit and reveal both went through the real, publicly hosted HTTPS relay, confirmed independently on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
