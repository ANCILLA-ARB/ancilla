import { JsonRpcProvider, Wallet, Contract, AbiCoder } from "ethers";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildIntent } from "../sdk/intent";
import { signCommitRequest, signRevealRequest } from "../sdk/relay";

/**
 * Live proof that the relay is NOT a single point of failure: starts TWO
 * independent relay-server instances (different ports, different relay
 * wallets), hands the SAME signed reveal request to both, kills ONE of
 * them before the reveal window even opens, and confirms the SURVIVING
 * instance still gets the reveal on-chain.
 *
 * This works because commitIntentViaRelay/revealIntentViaRelay are both
 * permissionless — any holder of a validly signed request can submit it,
 * not just one designated relay address (see the contract's NatSpec).
 *
 * Prerequisites:
 *   1. `npx hardhat node` running
 *   2. `npx hardhat run scripts/deploy-local.ts --network localhost`
 * This script starts and stops both relay-server instances itself.
 */

const RPC_URL = "http://127.0.0.1:8545";
const RELAY_A_PORT = 8788;
const RELAY_B_PORT = 8789;

// Hardhat's default local test accounts — see scripts/relay-server-e2e.ts
// for why these are copied verbatim from actual node log output, not
// recalled from memory.
const AGENT_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const RELAY_A_PRIVATE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // account #2
const RELAY_B_PRIVATE_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // account #3

const ABI = [
  "function depositBond() payable",
  "function bondBalance(address) view returns (uint256)",
  "function lockedBond(address) view returns (uint256)",
  "function minBond() view returns (uint256)",
  "function commitIntentViaRelay(bytes32 commitId, bytes32 commitHash, address agent, uint256 deadline, bytes signature) returns ()",
  "function commitments(bytes32) view returns (bytes32 commitHash, address agent, uint64 epoch, bool revealed, bool slashed)",
  "function currentEpoch() view returns (uint64)",
  "function revealOpenTimeOf(uint64) view returns (uint64)",
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function startRelay(port: number, relayKey: string, contractAddress: string): ChildProcess {
  const child = spawn("npx", ["ts-node", "relay-server/index.ts"], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_RPC_URL: RPC_URL,
      RELAY_CONTRACT_ADDRESS: contractAddress,
      RELAY_PRIVATE_KEY: relayKey,
    },
    cwd: path.join(__dirname, ".."),
    shell: true,
  });
  child.stdout?.on("data", (d) => process.stdout.write(`[relay:${port}] ${d}`));
  child.stderr?.on("data", (d) => process.stderr.write(`[relay:${port}] ${d}`));
  return child;
}

async function waitForHealth(port: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`relay on port ${port} did not become healthy within ${timeoutMs}ms`);
}

async function main() {
  const deploymentPath = path.join(__dirname, "..", "relay-server", "local-deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`${deploymentPath} not found — run scripts/deploy-local.ts against --network localhost first`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  const provider = new JsonRpcProvider(RPC_URL);
  const agent = new Wallet(AGENT_PRIVATE_KEY, provider);
  const contract = new Contract(deployment.contractAddress, ABI, agent);

  // Declared outside the try block so `finally` can always reach them —
  // an earlier version of this script leaked both child processes on any
  // error between spawning them and the explicit kill() calls at the end,
  // since nothing ever cleaned them up on the error path (found the hard
  // way: a failed run left two relay-server processes running and holding
  // ports 8788/8789, blocking the next attempt until manually killed).
  let relayA: ChildProcess | undefined;
  let relayB: ChildProcess | undefined;

  try {
    console.log("[1/6] Starting two independent relay-server instances (A and B)...");
    relayA = startRelay(RELAY_A_PORT, RELAY_A_PRIVATE_KEY, deployment.contractAddress);
    relayB = startRelay(RELAY_B_PORT, RELAY_B_PRIVATE_KEY, deployment.contractAddress);
    await Promise.all([waitForHealth(RELAY_A_PORT), waitForHealth(RELAY_B_PORT)]);
    console.log("   both relays healthy.");

    await runScenario(contract, agent, provider, deployment, relayA, relayB);
  } finally {
    relayA?.kill("SIGKILL");
    relayB?.kill("SIGKILL");
  }
}

async function runScenario(
  contract: Contract,
  agent: Wallet,
  provider: JsonRpcProvider,
  deployment: any,
  relayA: ChildProcess,
  relayB: ChildProcess
) {
  console.log("\n[2/6] Agent deposits bond and commits an intent directly...");
  const minBond: bigint = await contract.minBond();
  const locked: bigint = await contract.lockedBond(agent.address);
  const bond: bigint = await contract.bondBalance(agent.address);
  const needed = locked + minBond;
  if (bond < needed) {
    const tx = await contract.depositBond({ value: needed - bond });
    await tx.wait();
  }

  const nonce = Date.now();
  const intentData = AbiCoder.defaultAbiCoder().encode(["string"], [`multi-relay-e2e:${nonce}`]);
  const built = buildIntent(agent.address, intentData, nonce);
  const network = await provider.getNetwork();

  const commitReq = await signCommitRequest(agent, network.chainId, deployment.contractAddress, built.commitId, built.commitHash, 3600);
  const commitTx = await contract.commitIntentViaRelay(
    built.commitId,
    built.commitHash,
    agent.address,
    commitReq.value.deadline,
    commitReq.signature
  );
  await commitTx.wait();
  console.log("   committed:", built.commitId);

  console.log("\n[3/6] Agent signs ONE reveal request and POSTs the SAME payload to BOTH relays...");
  const revealReq = await signRevealRequest(
    agent,
    network.chainId,
    deployment.contractAddress,
    built.commitId,
    built.intentData,
    built.salt,
    deployment.executorAddress,
    3600
  );
  const revealBody = JSON.stringify({
    commitId: built.commitId,
    intentData: built.intentData,
    salt: built.salt,
    executor: deployment.executorAddress,
    agent: agent.address,
    deadline: revealReq.value.deadline.toString(),
    signature: revealReq.signature,
  });

  const [resA, resB] = await Promise.all([
    fetch(`http://127.0.0.1:${RELAY_A_PORT}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: revealBody }).then((r) => r.json()),
    fetch(`http://127.0.0.1:${RELAY_B_PORT}/reveal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: revealBody }).then((r) => r.json()),
  ]);
  console.log("   relay A accepted:", resA);
  console.log("   relay B accepted:", resB);

  console.log("\n[4/6] Killing relay A RIGHT NOW, before the reveal window has even opened...");
  relayA.kill("SIGKILL");
  console.log("   relay A killed. Only relay B remains to complete this reveal.");

  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  console.log(`   (reveal window opens at unix ${openTime})`);

  console.log("\n[5/6] Polling relay B's /status until it confirms on-chain (relay A is gone and cannot help)...");
  let finalStatus: any = null;
  for (let i = 0; i < 30; i++) {
    const status = await fetch(`http://127.0.0.1:${RELAY_B_PORT}/status/${built.commitId}`).then((r) => r.json());
    process.stdout.write(` [${status.status}]`);
    if (status.status === "confirmed" || status.status === "failed" || status.status === "expired") {
      finalStatus = status;
      break;
    }
    await sleep(5000);
  }
  console.log("\n   relay B final status:", finalStatus);

  console.log("\n[6/6] Independently verifying on-chain that the reveal actually happened...");
  const stored = await contract.commitments(built.commitId);
  const success = finalStatus?.status === "confirmed" && stored.revealed === true;
  console.log("   commitments(commitId).revealed =", stored.revealed);

  console.log(
    success
      ? "\n✅ MULTI-RELAY REDUNDANCY PROVEN — killing relay A mid-flight did not block the reveal; relay B completed it independently."
      : "\n❌ MULTI-RELAY REDUNDANCY TEST FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
