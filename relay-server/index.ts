import { JsonRpcProvider, Wallet } from "ethers";
import * as dotenv from "dotenv";
import { createRelayApp } from "./app";

dotenv.config({ quiet: true });

/**
 * Ancilla relay server — CLI entry point. The actual Express app and
 * background worker live in app.ts (createRelayApp), factored out
 * specifically so they can be constructed and tested in-process (see
 * test/relay-server.test.ts, using supertest against Hardhat's in-process
 * network) without spawning a real child process or binding a real port.
 * This file's only job is: read config from env vars, build a real
 * provider/signer, start listening, start the poll timer.
 *
 * WHAT THIS IS: a working prototype of the "relay" role described in the
 * contract and README. Agents POST signed authorizations here instead of
 * ever submitting a transaction to IntentCommitReveal themselves; this
 * process holds the relay's private key, submits on their behalf, and pays
 * gas from its own wallet. The pending-reveal queue is persisted to a local
 * JSON file so a process restart doesn't drop work that was already
 * accepted — and because commitIntentViaRelay / revealIntentViaRelay are
 * BOTH permissionless (any holder of a validly signed request may submit
 * it, not just one designated relay address — see the contract's NatSpec),
 * an agent can hand the same signed request to MULTIPLE independent
 * relay-server instances at once. Whichever gets there first wins; the
 * rest just hit AlreadyRevealed/AlreadyCommitted and no-op harmlessly.
 * That redundancy is demonstrated live in
 * scripts/relay-server-multi-e2e.ts, which starts two relay-server
 * instances, submits the same reveal to both, kills one mid-flight, and
 * confirms the other still completes it.
 *
 * WHAT THIS IS NOT: a hosted, always-on, production service. Each instance
 * still runs as a local Node process for as long as you keep it running —
 * there is no deployment to a VPS/cloud host, no TLS, no auth/rate-limiting,
 * and no COORDINATION between instances (each just independently races to
 * submit whatever it was told about — there's no shared queue or leader
 * election). Real decentralization would need agents/clients to actually
 * broadcast to multiple known relay endpoints (not built here — this repo
 * only proves the mechanism tolerates it), plus relay operator
 * discovery/reputation, which is unbuilt.
 */

const PORT = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 8787;
const RPC_URL = process.env.RELAY_RPC_URL || "http://127.0.0.1:8545";
const CONTRACT_ADDRESS = process.env.RELAY_CONTRACT_ADDRESS;
const RELAY_PRIVATE_KEY = process.env.RELAY_PRIVATE_KEY;

if (!CONTRACT_ADDRESS) throw new Error("RELAY_CONTRACT_ADDRESS not set");
if (!RELAY_PRIVATE_KEY) throw new Error("RELAY_PRIVATE_KEY not set");

// Per-instance file so two relay-server processes running side by side
// (e.g. the multi-relay redundancy demo) never clobber each other's queue.
const STORE_PATH = process.env.RELAY_STORE_PATH || `relay-server/.queue-${PORT}.json`;

const provider = new JsonRpcProvider(RPC_URL);
const relayWallet = new Wallet(RELAY_PRIVATE_KEY, provider);

const { app, jobs, processPendingReveals } = createRelayApp({
  contractAddress: CONTRACT_ADDRESS,
  relaySigner: relayWallet,
  storePath: STORE_PATH,
});

if (jobs.size > 0) {
  console.log(`Loaded ${jobs.size} job(s) from ${STORE_PATH} (surviving a restart)`);
}

const POLL_INTERVAL_MS = 5000;
const pollTimer = setInterval(() => {
  processPendingReveals().catch((err) => console.error("processPendingReveals error:", err));
}, POLL_INTERVAL_MS);

const server = app.listen(PORT, () => {
  console.log(`Ancilla relay server listening on http://127.0.0.1:${PORT}`);
  console.log(`  relay wallet: ${relayWallet.address}`);
  console.log(`  contract:     ${CONTRACT_ADDRESS}`);
  console.log(`  rpc:          ${RPC_URL}`);
  console.log(`  polling every ${POLL_INTERVAL_MS}ms for reveal windows opening`);
});

process.on("SIGTERM", () => {
  clearInterval(pollTimer);
  server.close(() => process.exit(0));
});
process.on("SIGINT", () => {
  clearInterval(pollTimer);
  server.close(() => process.exit(0));
});
