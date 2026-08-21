import { JsonRpcProvider, Wallet, Contract, AbiCoder } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { buildIntent } from "../sdk/intent";
import { signCommitRequest, signRevealRequest } from "../sdk/relay";

/**
 * End-to-end proof that the relay-server prototype (relay-server/index.ts)
 * actually works: talks to it purely over HTTP, exactly the way a real
 * agent client would — never touches the contract directly except to
 * independently verify the outcome afterward.
 *
 * Prerequisites (see relay-server/README.md):
 *   1. `npx hardhat node` running
 *   2. `npx hardhat run scripts/deploy-local.ts --network localhost`
 *   3. `npm run relay-server` (pointed at that node/deployment)
 * Then: `npm run relay-server:e2e`
 */

const RELAY_URL = process.env.RELAY_URL || "http://127.0.0.1:8787";
const RPC_URL = "http://127.0.0.1:8545";

// Hardhat's default local test accounts (public, documented, funded with
// fake ETH only on an ephemeral local chain — not a secret). Copied
// character-for-character from this project's own `npx hardhat node` log
// output and verified by deriving the address and checking it against what
// the node printed — an earlier attempt to recall this key from memory
// alone was subtly wrong (missing one trailing hex digit), the same class
// of mistake as the SECP256K1_HALF_N bug documented in the main README.
const AGENT_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const ABI = [
  "function depositBond() payable",
  "function bondBalance(address) view returns (uint256)",
  "function lockedBond(address) view returns (uint256)",
  "function minBond() view returns (uint256)",
  "function commitments(bytes32) view returns (bytes32 commitHash, address agent, uint64 epoch, bool revealed, bool slashed)",
  "function currentEpoch() view returns (uint64)",
  "function revealOpenTimeOf(uint64) view returns (uint64)",
];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "relay-server", "local-deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`${deploymentPath} not found — run scripts/deploy-local.ts against --network localhost first`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  console.log("Using deployment:", deployment);

  const provider = new JsonRpcProvider(RPC_URL);
  const agent = new Wallet(AGENT_PRIVATE_KEY, provider);
  console.log("Agent wallet:", agent.address);

  const contract = new Contract(deployment.contractAddress, ABI, agent);

  // Health check the relay server first.
  const health = await fetch(`${RELAY_URL}/health`).then((r) => r.json());
  console.log("Relay server health:", health);
  if (health.relay?.toLowerCase() === agent.address.toLowerCase()) {
    throw new Error("Relay and agent must be different wallets");
  }

  // Agent funds its own bond directly — this part isn't relayed (Ancilla
  // relays commit/reveal, not arbitrary contract calls).
  console.log("\n[1/5] Agent deposits bond directly...");
  const minBond: bigint = await contract.minBond();
  let bond: bigint = await contract.bondBalance(agent.address);
  const locked: bigint = await contract.lockedBond(agent.address);
  // Must cover minBond ON TOP OF whatever is already locked against any
  // unresolved commitment from a previous run of this script (re-running
  // this E2E without resolving the prior commitment first — e.g. if an
  // earlier attempt failed after committing but before revealing — leaves
  // bond locked; topping up only to `minBond` total, ignoring `locked`,
  // reproduces exactly the BondTooLow this comment is here to prevent).
  const needed = locked + minBond;
  if (bond < needed) {
    const tx = await contract.depositBond({ value: needed - bond });
    await tx.wait();
  }
  console.log("   bond OK:", (await contract.bondBalance(agent.address)).toString());

  console.log("\n[2/5] Agent signs a CommitRequest and POSTs it to the relay server's /commit...");
  const nonce = Date.now();
  const intentData = AbiCoder.defaultAbiCoder().encode(["string"], [`relay-server-e2e:${nonce}`]);
  const built = buildIntent(agent.address, intentData, nonce);
  const network = await provider.getNetwork();

  const commitReq = await signCommitRequest(
    agent,
    network.chainId,
    deployment.contractAddress,
    built.commitId,
    built.commitHash,
    3600
  );

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
  console.log("   relay server responded:", commitRes);
  if (!commitRes.ok) throw new Error("commit relay failed: " + JSON.stringify(commitRes));

  console.log("\n[3/5] Independently verifying the commit landed on-chain, attributed to the agent...");
  const storedAfterCommit = await contract.commitments(built.commitId);
  console.log("   commitments(commitId).agent =", storedAfterCommit.agent, storedAfterCommit.agent === agent.address ? "✓" : "✗ MISMATCH");

  console.log("\n[4/5] Agent signs a RevealRequest and POSTs it to /reveal BEFORE the window even opens...");
  const executorAddr = deployment.executorAddress;
  const revealReq = await signRevealRequest(
    agent,
    network.chainId,
    deployment.contractAddress,
    built.commitId,
    built.intentData,
    built.salt,
    executorAddr,
    3600
  );
  const revealRes = await fetch(`${RELAY_URL}/reveal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commitId: built.commitId,
      intentData: built.intentData,
      salt: built.salt,
      executor: executorAddr,
      agent: agent.address,
      deadline: revealReq.value.deadline.toString(),
      signature: revealReq.signature,
    }),
  }).then((r) => r.json());
  console.log("   relay server accepted (queued):", revealRes);

  console.log("\n[5/5] Polling GET /status until the relay server's background worker confirms it on-chain...");
  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  console.log(`   (reveal window opens at unix ${openTime}; relay server polls every 5s)`);

  let finalStatus: any = null;
  for (let i = 0; i < 30; i++) {
    const status = await fetch(`${RELAY_URL}/status/${built.commitId}`).then((r) => r.json());
    process.stdout.write(` [${status.status}]`);
    if (status.status === "confirmed" || status.status === "failed" || status.status === "expired") {
      finalStatus = status;
      break;
    }
    await sleep(5000);
  }
  console.log("\n   final status from relay server:", finalStatus);

  const storedFinal = await contract.commitments(built.commitId);
  const success = finalStatus?.status === "confirmed" && storedFinal.revealed === true;
  console.log(
    success
      ? "\n✅ RELAY SERVER E2E PASSED — commit and reveal both went through the HTTP relay server, never a direct agent->contract call for either."
      : "\n❌ RELAY SERVER E2E FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
