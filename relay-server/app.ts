import express, { Express, Request, Response } from "express";
import { Contract, Signer } from "ethers";
import * as fs from "fs";

/**
 * The relay-server's Express app + background worker, factored out of
 * index.ts (the CLI entry point) so it can be constructed and tested
 * in-process — via supertest, against Hardhat's in-process network — without
 * spawning a real child process or binding a real port. index.ts is now a
 * thin wrapper: read env vars, call createRelayApp(), start listening.
 */

// Custom errors MUST be listed here too, not just functions — without them
// ethers can't decode which specific error a revert corresponds to. See
// decodeErrorName()'s doc comment for the two failed attempts that preceded
// this being correctly wired up.
export const RELAY_ABI = [
  "function currentEpoch() view returns (uint64)",
  "function revealOpenTimeOf(uint64 epoch) view returns (uint64)",
  "function revealCloseTimeOf(uint64 epoch) view returns (uint64)",
  "function commitments(bytes32) view returns (bytes32 commitHash, address agent, uint64 epoch, bool revealed, bool slashed)",
  "function commitIntentViaRelay(bytes32 commitId, bytes32 commitHash, address agent, uint256 deadline, bytes signature) returns ()",
  "function revealIntentViaRelay(bytes32 commitId, bytes intentData, bytes32 salt, address executor, address agent, uint256 deadline, bytes signature) returns (bool)",
  "error BondTooLow(uint256 have, uint256 need)",
  "error CommitAlreadyExists()",
  "error CommitNotFound()",
  "error AlreadyRevealed()",
  "error AlreadySlashed()",
  "error RevealNotOpenYet(uint64 opensAt)",
  "error RevealWindowClosed(uint64 closedAt)",
  "error HashMismatch()",
  "error StillInsideRevealWindow(uint64 closesAt)",
  "error InsufficientFreeBond()",
  "error SignatureExpired(uint256 deadline)",
  "error InvalidSignatureLength()",
  "error InvalidSignatureS()",
  "error InvalidSignatureV()",
  "error InvalidSigner()",
];

export type RevealJobStatus = "pending" | "submitted" | "confirmed" | "failed" | "expired";

export interface RevealJob {
  commitId: string;
  intentData: string;
  salt: string;
  executor: string;
  agent: string;
  deadline: bigint;
  signature: string;
  status: RevealJobStatus;
  txHash?: string;
  error?: string;
  createdAt: number;
}

export interface RelayAppConfig {
  contractAddress: string;
  relaySigner: Signer;
  /** Path to persist the pending-reveal queue to. Omit to keep it in-memory
   *  only (used by tests, so parallel test runs never touch real disk state
   *  or collide with each other on a shared file). */
  storePath?: string;
}

export interface RelayApp {
  app: Express;
  contract: Contract;
  jobs: Map<string, RevealJob>;
  processPendingReveals: () => Promise<void>;
  decodeErrorName: (err: any) => string | undefined;
}

function loadJobs(storePath: string | undefined): Map<string, RevealJob> {
  if (!storePath || !fs.existsSync(storePath)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, any>;
    const map = new Map<string, RevealJob>();
    for (const [commitId, job] of Object.entries(raw)) {
      map.set(commitId, { ...job, deadline: BigInt(job.deadline) });
    }
    return map;
  } catch (err) {
    console.error(`Failed to load ${storePath}, starting with an empty queue:`, err);
    return new Map();
  }
}

function saveJobs(jobs: Map<string, RevealJob>, storePath: string | undefined) {
  if (!storePath) return; // in-memory only mode (tests)
  const serializable: Record<string, any> = {};
  for (const [commitId, job] of jobs.entries()) {
    serializable[commitId] = { ...job, deadline: job.deadline.toString() };
  }
  fs.writeFileSync(storePath, JSON.stringify(serializable, null, 2));
}

export function createRelayApp(config: RelayAppConfig): RelayApp {
  const { contractAddress, relaySigner, storePath } = config;
  const contract = new Contract(contractAddress, RELAY_ABI, relaySigner);
  const jobs = loadJobs(storePath);

  /** Decode a revert's custom-error name from raw revert data via the
   *  contract's own Interface. This is the one reliable way found to do
   *  this — two other approaches were tried and both silently misclassified
   *  every error as "unknown custom error" instead of throwing loudly:
   *   1. Passing an ABI to ethers.Contract with only function signatures,
   *      no error signatures — ethers had nothing to decode against.
   *   2. After adding error signatures, reading `err.revert.name` /
   *      `err.errorName` off the thrown exception — neither property is
   *      actually populated by this ethers version's CALL_EXCEPTION errors
   *      (confirmed by logging the raw error and manually matching the
   *      4-byte selector in `err.data` against each error's keccak256 hash
   *      by hand). `Interface.parseError(rawData)` is the documented,
   *      version-independent way to do this decode. */
  function decodeErrorName(err: any): string | undefined {
    if (!err?.data) return undefined;
    try {
      return contract.interface.parseError(err.data)?.name;
    } catch {
      return undefined;
    }
  }

  const app = express();
  app.use(express.json());

  app.get("/health", async (_req: Request, res: Response) => {
    res.json({ ok: true, relay: await relaySigner.getAddress(), contract: contractAddress });
  });

  app.post("/commit", async (req: Request, res: Response) => {
    const { commitId, commitHash, agent, deadline, signature } = req.body || {};
    if (!commitId || !commitHash || !agent || !deadline || !signature) {
      return res.status(400).json({ error: "commitId, commitHash, agent, deadline, signature are all required" });
    }
    try {
      const tx = await contract.commitIntentViaRelay(commitId, commitHash, agent, deadline, signature);
      const receipt = await tx.wait();
      return res.json({ ok: true, txHash: tx.hash, blockNumber: receipt.blockNumber });
    } catch (err: any) {
      const errorName = decodeErrorName(err);
      const message = errorName || err?.shortMessage || err?.message || String(err);
      return res.status(422).json({ ok: false, error: message });
    }
  });

  app.post("/reveal", (req: Request, res: Response) => {
    const { commitId, intentData, salt, executor, agent, deadline, signature } = req.body || {};
    if (!commitId || !intentData || !salt || !executor || !agent || !deadline || !signature) {
      return res.status(400).json({
        error: "commitId, intentData, salt, executor, agent, deadline, signature are all required",
      });
    }
    const job: RevealJob = {
      commitId,
      intentData,
      salt,
      executor,
      agent,
      deadline: BigInt(deadline),
      signature,
      status: "pending",
      createdAt: Date.now(),
    };
    jobs.set(commitId, job);
    saveJobs(jobs, storePath);
    return res.status(202).json({ ok: true, accepted: true, commitId, status: job.status });
  });

  app.get("/status/:commitId", (req: Request, res: Response) => {
    const commitId = String(req.params.commitId);
    const job = jobs.get(commitId);
    if (!job) return res.status(404).json({ error: "no reveal job known for this commitId" });
    return res.json({ commitId: job.commitId, status: job.status, txHash: job.txHash, error: job.error });
  });

  /** Called on a timer by index.ts in production, or directly/manually by
   *  tests — tries to submit any pending reveal whose window has opened. */
  async function processPendingReveals() {
    for (const job of jobs.values()) {
      if (job.status !== "pending") continue;

      // This is a real wall-clock (Date.now()) pre-check, purely a gas-saving
      // optimization to skip an attempt that would just revert anyway — it is
      // NOT the authoritative check. The contract's own
      // `block.timestamp > deadline` check inside revealIntentViaRelay is
      // authoritative and fires independently below (surfacing as a
      // SignatureExpired failure) if this local pre-check doesn't catch a
      // passed deadline first — e.g. if this process's clock is behind, or
      // (only relevant in tests) if only a simulated chain's clock advanced,
      // not real wall-clock time. Both paths are safe terminal states; see
      // test/relay-server.test.ts for the test that found this distinction.
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (now > job.deadline) {
        job.status = "expired";
        job.error = "signature deadline passed before the reveal window opened";
        saveJobs(jobs, storePath);
        continue;
      }

      try {
        const tx = await contract.revealIntentViaRelay(
          job.commitId,
          job.intentData,
          job.salt,
          job.executor,
          job.agent,
          job.deadline,
          job.signature
        );
        job.status = "submitted";
        job.txHash = tx.hash;
        saveJobs(jobs, storePath);
        const receipt = await tx.wait();
        job.status = receipt.status === 1 ? "confirmed" : "failed";
        saveJobs(jobs, storePath);
      } catch (err: any) {
        const decodedName = decodeErrorName(err);
        if (decodedName === "RevealNotOpenYet") {
          continue; // expected while waiting — leave pending, retry next tick
        }
        if (decodedName === "AlreadyRevealed") {
          // A different relay instance (or the agent itself) got there
          // first — redundancy working as intended, not a failure.
          job.status = "confirmed";
          job.error = "resolved by a different relay instance (redundancy working as intended)";
          saveJobs(jobs, storePath);
          continue;
        }
        job.status = "failed";
        job.error = decodedName || err?.shortMessage || err?.message || String(err);
        saveJobs(jobs, storePath);
      }
    }
  }

  return { app, contract, jobs, processPendingReveals, decodeErrorName };
}
