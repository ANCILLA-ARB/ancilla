import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import request from "supertest";
import { createRelayApp } from "../relay-server/app";
import { buildIntent } from "../sdk/intent";
import { signCommitRequest, signRevealRequest } from "../sdk/relay";

/**
 * Automated tests for the relay-server Express app, running entirely
 * in-process against Hardhat's in-process network — no `npx hardhat node`,
 * no spawned child process, no real port binding (supertest talks to the
 * Express app object directly). Everything previously verified here was
 * only checked by manually running scripts/relay-server-e2e.ts /
 * relay-server-multi-e2e.ts against a real spawned server; this suite
 * closes that "zero automated coverage" gap for the relay-server package.
 */

const COMMIT_WINDOW = 300;
const REVEAL_DELAY = 60;
const REVEAL_WINDOW = 300;
const MIN_BOND = ethers.parseEther("0.1");
const DEADLINE_BUFFER = 1_000_000; // see main test file for why this needs to be huge

describe("relay-server app", function () {
  async function deploy() {
    const [treasury, agent, relay, other, guardian] = await ethers.getSigners();

    const Contract = await ethers.getContractFactory("IntentCommitReveal");
    const contract = await Contract.deploy(
      COMMIT_WINDOW,
      REVEAL_DELAY,
      REVEAL_WINDOW,
      MIN_BOND,
      treasury.address,
      guardian.address
    );
    await contract.waitForDeployment();

    const Executor = await ethers.getContractFactory("MockExecutor");
    const executor = await Executor.deploy();
    await executor.waitForDeployment();

    const contractAddress = await contract.getAddress();
    const relayApp = createRelayApp({
      contractAddress,
      relaySigner: relay,
      // storePath deliberately omitted: in-memory only, so parallel test
      // runs never touch real disk state.
    });

    return { contract, executor, treasury, agent, relay, other, relayApp, contractAddress };
  }

  it("GET /health reports the relay's own address and target contract", async function () {
    const { relayApp, relay, contractAddress } = await loadFixture(deploy);
    const res = await request(relayApp.app).get("/health");
    expect(res.status).to.equal(200);
    expect(res.body.ok).to.equal(true);
    expect(res.body.relay).to.equal(relay.address);
    expect(res.body.contract).to.equal(contractAddress);
  });

  describe("POST /commit", function () {
    it("rejects a request missing required fields", async function () {
      const { relayApp } = await loadFixture(deploy);
      const res = await request(relayApp.app).post("/commit").send({ commitId: "0x1234" });
      expect(res.status).to.equal(400);
    });

    it("submits a validly signed commit and attributes it to the agent, not the relay", async function () {
      const { contract, agent, relay, relayApp, contractAddress } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relay-server test commit"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();
      const { value, signature } = await signCommitRequest(
        agent,
        network.chainId,
        contractAddress,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );

      const res = await request(relayApp.app).post("/commit").send({
        commitId: built.commitId,
        commitHash: built.commitHash,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      expect(res.status).to.equal(200);
      expect(res.body.ok).to.equal(true);
      expect(res.body.txHash).to.be.a("string");

      const stored = await contract.commitments(built.commitId);
      expect(stored.agent).to.equal(agent.address); // attributed to agent, not relay
      expect(stored.agent).to.not.equal(relay.address);
    });

    it("returns the decoded error name (not 'unknown custom error') when the contract rejects the commit", async function () {
      const { agent, other, relayApp, contractAddress } = await loadFixture(deploy);
      // `other` signs but claims to be `agent` — InvalidSigner.
      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["bad signer"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();
      const { value, signature } = await signCommitRequest(
        other,
        network.chainId,
        contractAddress,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );

      const res = await request(relayApp.app).post("/commit").send({
        commitId: built.commitId,
        commitHash: built.commitHash,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      expect(res.status).to.equal(422);
      expect(res.body.ok).to.equal(false);
      expect(res.body.error).to.equal("InvalidSigner"); // decoded name, not "unknown custom error"
    });
  });

  describe("POST /reveal + processPendingReveals", function () {
    async function committed() {
      const base = await loadFixture(deploy);
      const { contract, agent } = base;
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relay-server test reveal"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      return { ...base, built };
    }

    it("accepts and queues a reveal request as pending (202), without submitting it yet", async function () {
      const { executor, agent, relayApp, contractAddress, built } = await committed();
      const network = await ethers.provider.getNetwork();
      const executorAddr = await executor.getAddress();
      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddress,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );

      const res = await request(relayApp.app).post("/reveal").send({
        commitId: built.commitId,
        intentData: built.intentData,
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      expect(res.status).to.equal(202);
      expect(res.body.status).to.equal("pending");
      expect(relayApp.jobs.get(built.commitId)?.status).to.equal("pending");
    });

    it("GET /status/:commitId 404s for a commitId the relay never received", async function () {
      const { relayApp } = await loadFixture(deploy);
      const res = await request(relayApp.app).get("/status/0x" + "ab".repeat(32));
      expect(res.status).to.equal(404);
    });

    it("leaves a job pending (not failed) when processPendingReveals runs before the window opens", async function () {
      const { executor, agent, relayApp, contractAddress, built } = await committed();
      const network = await ethers.provider.getNetwork();
      const executorAddr = await executor.getAddress();
      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddress,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );
      await request(relayApp.app).post("/reveal").send({
        commitId: built.commitId,
        intentData: built.intentData,
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      // Window hasn't opened yet — this is the exact scenario that used to
      // be wrongly marked "failed" before the ABI/error-decoding bugs
      // (documented in relay-server/README.md) were fixed.
      await relayApp.processPendingReveals();
      expect(relayApp.jobs.get(built.commitId)?.status).to.equal("pending");
    });

    it("submits and confirms once the window opens, verified independently on-chain", async function () {
      const { contract, executor, agent, relayApp, contractAddress, built } = await committed();
      const network = await ethers.provider.getNetwork();
      const executorAddr = await executor.getAddress();
      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddress,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );
      await request(relayApp.app).post("/reveal").send({
        commitId: built.commitId,
        intentData: built.intentData,
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealOpenTimeOf(epoch));

      await relayApp.processPendingReveals();
      expect(relayApp.jobs.get(built.commitId)?.status).to.equal("confirmed");

      const stored = await contract.commitments(built.commitId);
      expect(stored.revealed).to.equal(true);

      const statusRes = await request(relayApp.app).get(`/status/${built.commitId}`);
      expect(statusRes.body.status).to.equal("confirmed");
      expect(statusRes.body.txHash).to.be.a("string");
    });

    it("never leaves a job stuck pending once its deadline has passed — either local pre-check or the contract's own check catches it", async function () {
      // Two different code paths can end a job's life once its deadline
      // passes, and this test found (rather than assumed) the distinction:
      //   - LOCAL pre-check: processPendingReveals() compares its own
      //     Date.now() (real wall-clock) against job.deadline BEFORE
      //     attempting a transaction, marking the job "expired" without
      //     spending any gas. This only fires if real wall-clock time has
      //     actually passed the deadline.
      //   - ON-CHAIN fallback: if the local pre-check doesn't fire (e.g.
      //     this test only fast-forwards the *simulated chain's* clock via
      //     time.increase(), not real wall-clock Date.now() — so the local
      //     pre-check never sees deadline as passed), the relay attempts
      //     the tx anyway, and the contract's own authoritative
      //     `block.timestamp > deadline` check rejects it with
      //     SignatureExpired, landing the job as "failed" with that reason.
      // Both are safe terminal outcomes — a job never sits "pending"
      // forever past its deadline — so this test asserts that invariant
      // rather than one specific status label.
      const { executor, agent, relayApp, contractAddress, built } = await committed();
      const network = await ethers.provider.getNetwork();
      const executorAddr = await executor.getAddress();
      // Deliberately short deadline, shorter than the reveal delay, so the
      // window can never open before this expires.
      const shortDeadline = (await time.latest()) + 5;
      const structValue = {
        commitId: built.commitId,
        intentDataHash: ethers.keccak256(built.intentData),
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: BigInt(shortDeadline),
      };
      const domain = { name: "Ancilla", version: "1", chainId: network.chainId, verifyingContract: contractAddress };
      const types = {
        RevealRequest: [
          { name: "commitId", type: "bytes32" },
          { name: "intentDataHash", type: "bytes32" },
          { name: "salt", type: "bytes32" },
          { name: "executor", type: "address" },
          { name: "agent", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const signature = await agent.signTypedData(domain, types, structValue);

      await request(relayApp.app).post("/reveal").send({
        commitId: built.commitId,
        intentData: built.intentData,
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: shortDeadline.toString(),
        signature,
      });

      await time.increase(10); // now past shortDeadline, still before the real reveal window
      await relayApp.processPendingReveals();

      const job = relayApp.jobs.get(built.commitId);
      expect(job?.status).to.be.oneOf(["expired", "failed"]);
      expect(job?.status).to.not.equal("pending");
      expect(job?.status).to.not.equal("confirmed"); // must not have been wrongly accepted past its deadline
      if (job?.status === "failed") {
        expect(job.error).to.equal("SignatureExpired"); // on-chain fallback caught it correctly, if the local pre-check didn't
      }
    });

    it("treats AlreadyRevealed as success (a different relay/agent resolved it), not a failure", async function () {
      // Simulates the multi-relay redundancy scenario in-process: reveal
      // the commitment directly (as if a sibling relay instance beat this
      // one to it), then let this relay's own worker discover that.
      const { contract, executor, agent, relayApp, contractAddress, built } = await committed();
      const network = await ethers.provider.getNetwork();
      const executorAddr = await executor.getAddress();
      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddress,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );
      await request(relayApp.app).post("/reveal").send({
        commitId: built.commitId,
        intentData: built.intentData,
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline: value.deadline.toString(),
        signature,
      });

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealOpenTimeOf(epoch));

      // "A sibling relay" reveals it first, directly.
      await contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, executorAddr);

      // This relay's own worker only finds out now.
      await relayApp.processPendingReveals();
      const job = relayApp.jobs.get(built.commitId);
      expect(job?.status).to.equal("confirmed");
      expect(job?.error).to.include("resolved by a different relay instance");
    });
  });
});
