import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { buildIntent } from "../sdk/intent";
import { signRevealRequest, signCommitRequest, domainFor, REVEAL_REQUEST_TYPES, COMMIT_REQUEST_TYPES } from "../sdk/relay";

const COMMIT_WINDOW = 300; // seconds per epoch
const REVEAL_DELAY = 60; // seconds after epoch closes before reveal opens
const REVEAL_WINDOW = 300; // seconds reveal stays open
const MIN_BOND = ethers.parseEther("0.1");
const SLASHER_REWARD_BPS = 1000; // 10% — see IntentCommitReveal.sol's header comment
// Deliberately huge: signRevealRequest() computes its deadline from real
// wall-clock Date.now() (correct for a live network), but tests run against
// a Hardhat fixture whose block.timestamp can be minutes ahead of real time
// after time.increaseTo() — a short buffer like 300s intermittently expired
// before the test even got to submit it. This buffer swamps that gap.
const DEADLINE_BUFFER = 1_000_000;

/** Mine forward to the exact start of a fresh epoch, so a test has the full
 *  commit window ahead of it instead of landing at a random, possibly
 *  near-boundary offset. Uses block.timestamp (matches the contract), not
 *  block count — see IntentCommitReveal.sol's header comment for why. */
async function alignToFreshEpoch(commitWindow: number) {
  const now = await time.latest();
  const remainder = now % commitWindow;
  if (remainder !== 0) {
    await time.increase(commitWindow - remainder);
  }
}

describe("IntentCommitReveal", function () {
  async function deploy() {
    const [treasury, agent, other, guardian] = await ethers.getSigners();

    const Contract = await ethers.getContractFactory("IntentCommitReveal");
    const contract = await Contract.deploy(
      COMMIT_WINDOW,
      REVEAL_DELAY,
      REVEAL_WINDOW,
      MIN_BOND,
      treasury.address,
      guardian.address,
      SLASHER_REWARD_BPS
    );
    await contract.waitForDeployment();

    const Executor = await ethers.getContractFactory("MockExecutor");
    const executor = await Executor.deploy();
    await executor.waitForDeployment();

    return { contract, executor, treasury, agent, other, guardian };
  }

  describe("constructor validation", function () {
    it("rejects a zero commitWindowSeconds", async function () {
      const [treasury, , , guardian] = await ethers.getSigners();
      const Contract = await ethers.getContractFactory("IntentCommitReveal");
      await expect(
        Contract.deploy(0, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, treasury.address, guardian.address, SLASHER_REWARD_BPS)
      ).to.be.revertedWith("commitWindow=0");
    });

    it("rejects a zero revealWindowSeconds", async function () {
      const [treasury, , , guardian] = await ethers.getSigners();
      const Contract = await ethers.getContractFactory("IntentCommitReveal");
      await expect(
        Contract.deploy(COMMIT_WINDOW, REVEAL_DELAY, 0, MIN_BOND, treasury.address, guardian.address, SLASHER_REWARD_BPS)
      ).to.be.revertedWith("revealWindow=0");
    });

    it("rejects a zero treasury address", async function () {
      const [, , , guardian] = await ethers.getSigners();
      const Contract = await ethers.getContractFactory("IntentCommitReveal");
      await expect(
        Contract.deploy(COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, ethers.ZeroAddress, guardian.address, SLASHER_REWARD_BPS)
      ).to.be.revertedWith("treasury=0");
    });

    it("rejects a zero guardian address", async function () {
      const [treasury] = await ethers.getSigners();
      const Contract = await ethers.getContractFactory("IntentCommitReveal");
      await expect(
        Contract.deploy(COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, treasury.address, ethers.ZeroAddress, SLASHER_REWARD_BPS)
      ).to.be.revertedWith("guardian=0");
    });

    it("rejects a slasherRewardBps above 100%", async function () {
      const [treasury, , , guardian] = await ethers.getSigners();
      const Contract = await ethers.getContractFactory("IntentCommitReveal");
      await expect(
        Contract.deploy(COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, treasury.address, guardian.address, 10_001)
      ).to.be.revertedWith("slasherRewardBps>100%");
    });
  });

  describe("emergency pause", function () {
    it("lets the guardian pause and unpause", async function () {
      const { contract, guardian } = await loadFixture(deploy);
      expect(await contract.paused()).to.equal(false);
      await expect(contract.connect(guardian).pause()).to.emit(contract, "Paused").withArgs(guardian.address);
      expect(await contract.paused()).to.equal(true);
      await expect(contract.connect(guardian).unpause()).to.emit(contract, "Unpaused").withArgs(guardian.address);
      expect(await contract.paused()).to.equal(false);
    });

    it("rejects pause/unpause from anyone but the guardian", async function () {
      const { contract, agent } = await loadFixture(deploy);
      await expect(contract.connect(agent).pause()).to.be.revertedWithCustomError(contract, "NotGuardian");
      await expect(contract.connect(agent).unpause()).to.be.revertedWithCustomError(contract, "NotGuardian");
    });

    it("blocks new commits while paused, but never blocks resolving what's already committed", async function () {
      const { contract, executor, agent, guardian } = await loadFixture(deploy);
      await alignToFreshEpoch(COMMIT_WINDOW); // full commit window ahead, avoids an unrelated timing revert
      await contract.connect(agent).depositBond({ value: MIN_BOND });
      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
      const builtBeforePause = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(builtBeforePause.commitId, builtBeforePause.commitHash);

      await contract.connect(guardian).pause();

      // New commit: blocked.
      const builtDuringPause = buildIntent(agent.address, intentData, 2);
      await expect(
        contract.connect(agent).commitIntent(builtDuringPause.commitId, builtDuringPause.commitHash)
      ).to.be.revertedWithCustomError(contract, "EnforcedPause");

      // Resolving the commitment made before the pause: NOT blocked, even
      // while still paused.
      const c = await contract.commitments(builtBeforePause.commitId);
      const revealOpen = await contract.revealOpenTimeOf(c.epoch);
      await time.increaseTo(revealOpen);
      expect(await contract.paused()).to.equal(true); // still paused during this reveal
      await expect(
        contract.connect(agent).revealIntent(builtBeforePause.commitId, intentData, builtBeforePause.salt, await executor.getAddress())
      ).to.emit(contract, "IntentRevealed");
    });
  });

  it("rejects commit without enough bond", async function () {
    const { contract, agent } = await loadFixture(deploy);
    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
    const built = buildIntent(agent.address, intentData, 1);

    await expect(
      contract.connect(agent).commitIntent(built.commitId, built.commitHash)
    ).to.be.revertedWithCustomError(contract, "BondTooLow");
  });

  it("rejects revealing a commitId that was never committed", async function () {
    const { contract, executor, agent } = await loadFixture(deploy);
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("never-committed"));
    await expect(
      contract.connect(agent).revealIntent(fakeId, "0x", ethers.ZeroHash, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "CommitNotFound");
  });

  it("rejects a non-owner (not the committing agent) from revealing someone else's commitId", async function () {
    // Security-critical: Bob must not be able to reveal Alice's commitment
    // just because he learned the plaintext intentData+salt some other way.
    const { contract, executor, agent, other } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["alice's intent"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealOpenTimeOf(epoch));

    // `other` (Bob) tries to reveal `agent`'s (Alice's) commitId directly.
    await expect(
      contract.connect(other).revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "CommitNotFound");
  });

  it("rejects a second commit reusing the same commitId", async function () {
    const { contract, agent } = await loadFixture(deploy);
    // Deposit enough to cover TWO commitments' worth of locked bond, so the
    // second attempt below fails on CommitAlreadyExists specifically —
    // not on BondTooLow, which is a different (also correct, but not what
    // this test is checking) rejection reason now that bond locks per commit.
    await contract.connect(agent).depositBond({ value: MIN_BOND * 2n });

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["first"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    // Reusing the same commitId with a different hash must still be rejected
    // — the slot is claimed the moment it's first written.
    const otherHash = ethers.keccak256(ethers.toUtf8Bytes("different"));
    await expect(
      contract.connect(agent).commitIntent(built.commitId, otherHash)
    ).to.be.revertedWithCustomError(contract, "CommitAlreadyExists");
  });

  describe("withdrawBond", function () {
    it("lets an agent withdraw everything down to exactly zero", async function () {
      const { contract, agent } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const balBefore = await ethers.provider.getBalance(agent.address);
      const tx = await contract.connect(agent).withdrawBond(MIN_BOND);
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      await expect(tx).to.emit(contract, "BondWithdrawn").withArgs(agent.address, MIN_BOND, 0n);
      expect(await contract.bondBalance(agent.address)).to.equal(0n);

      const balAfter = await ethers.provider.getBalance(agent.address);
      // Agent got the ETH back, net of the gas it paid for this tx.
      expect(balAfter).to.equal(balBefore + MIN_BOND - gasCost);
    });

    it("rejects withdrawing more than the current bond balance", async function () {
      const { contract, agent } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      await expect(
        contract.connect(agent).withdrawBond(MIN_BOND + 1n)
      ).to.be.revertedWithCustomError(contract, "InsufficientFreeBond");
    });

    it("rejects a partial withdrawal that would leave a nonzero balance below minBond", async function () {
      const { contract, agent } = await loadFixture(deploy);
      // Deposit more than minBond, then try to withdraw down into the
      // "stranded between 0 and minBond" zone.
      const extra = ethers.parseEther("0.05");
      await contract.connect(agent).depositBond({ value: MIN_BOND + extra });

      // Withdrawing `extra + 1 wei` leaves (minBond - 1 wei): nonzero, below
      // minBond — must be rejected, since that balance could no longer
      // commit but also wasn't fully withdrawn (funds shouldn't get stuck
      // in an unusable in-between state silently).
      await expect(
        contract.connect(agent).withdrawBond(extra + 1n)
      ).to.be.revertedWithCustomError(contract, "InsufficientFreeBond");

      // Withdrawing exactly `extra` leaves precisely minBond — allowed.
      await expect(contract.connect(agent).withdrawBond(extra)).to.not.be.reverted;
      expect(await contract.bondBalance(agent.address)).to.equal(MIN_BOND);
    });

    it("reverts (not silently swallows) an ETH transfer that fails on withdrawal", async function () {
      // If the recipient can't accept plain ETH, the accounting update
      // must NOT have already happened when the transfer fails — proven
      // here by checking bondBalance is unchanged after the revert.
      const { contract } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();

      const Receiver = await ethers.getContractFactory("RejectingReceiver");
      const receiver = await Receiver.deploy(contractAddr);
      await receiver.waitForDeployment();
      const receiverAddr = await receiver.getAddress();

      await receiver.deposit({ value: MIN_BOND });
      expect(await contract.bondBalance(receiverAddr)).to.equal(MIN_BOND);

      await expect(receiver.tryWithdraw(MIN_BOND)).to.be.reverted;
      // Balance must be unchanged — the revert must have unwound the
      // `bondBalance[msg.sender] = remaining;` write too, not just skipped
      // the ETH send while leaving the ledger already decremented.
      expect(await contract.bondBalance(receiverAddr)).to.equal(MIN_BOND);
    });
  });

  it("still marks the commitment revealed even when the executor itself reports failure", async function () {
    // The contract's job is to enforce the commit-reveal + timing contract,
    // not to guarantee the downstream action succeeds. An executor that
    // reverts or returns false is a downstream concern — but it must not
    // leave the commitment permanently stuck as "not revealed" either,
    // since it can't be retried (a second reveal attempt correctly hits
    // AlreadyRevealed, not a silent no-op).
    const { contract, executor, agent } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    await executor.setShouldFail(true);

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["will fail"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealOpenTimeOf(epoch));

    const tx = await contract
      .connect(agent)
      .revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress());
    await expect(tx)
      .to.emit(contract, "IntentRevealed")
      .withArgs(built.commitId, agent.address, await executor.getAddress(), ethers.ZeroAddress, false); // success=false

    const stored = await contract.commitments(built.commitId);
    expect(stored.revealed).to.equal(true); // still marked revealed, not retryable

    await expect(
      contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "AlreadyRevealed");
  });

  it("full happy path: bond -> commit -> wait -> reveal -> executor called", async function () {
    const { contract, executor, agent } = await loadFixture(deploy);

    await contract.connect(agent).depositBond({ value: MIN_BOND });
    expect(await contract.bondBalance(agent.address)).to.equal(MIN_BOND);

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
    const built = buildIntent(agent.address, intentData, 1);

    const commitTx = await contract.connect(agent).commitIntent(built.commitId, built.commitHash);
    await expect(commitTx).to.emit(contract, "IntentCommitted");
    await commitTx.wait();

    const epoch = await contract.currentEpoch();
    const openTime = await contract.revealOpenTimeOf(epoch);

    // Revealing too early must fail.
    await expect(
      contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "RevealNotOpenYet");

    // Time-travel forward until the shared reveal window opens.
    await time.increaseTo(openTime);

    const revealTx = await contract
      .connect(agent)
      .revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress());
    await expect(revealTx)
      .to.emit(contract, "IntentRevealed")
      .withArgs(built.commitId, agent.address, await executor.getAddress(), ethers.ZeroAddress, true);
    await expect(revealTx).to.emit(executor, "Executed");

    const stored = await contract.commitments(built.commitId);
    expect(stored.revealed).to.equal(true);
  });

  it("rejects reveal with wrong salt/data (hash mismatch)", async function () {
    const { contract, executor, agent } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    const openTime = await contract.revealOpenTimeOf(epoch);
    await time.increaseTo(openTime);

    const wrongData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 999 ETH -> USDC"]);
    await expect(
      contract.connect(agent).revealIntent(built.commitId, wrongData, built.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "HashMismatch");
  });

  it("rejects reveal after the window closes", async function () {
    const { contract, executor, agent } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["rebalance"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    const closeTime = await contract.revealCloseTimeOf(epoch);
    await time.increaseTo(closeTime);

    await expect(
      contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "RevealWindowClosed");
  });

  it("slashes an agent who commits and never reveals, once the window has closed", async function () {
    const { contract, agent, treasury, other } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["ghost intent"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    const closeTime = await contract.revealCloseTimeOf(epoch);

    // Too early to slash.
    await expect(contract.connect(other).slashNoReveal(built.commitId)).to.be.revertedWithCustomError(
      contract,
      "StillInsideRevealWindow"
    );

    await time.increaseTo(closeTime);

    // Slash is called by a third party (`other`), NOT by treasury itself,
    // so the treasury's balance delta below is pure penalty, uncontaminated
    // by the caller's own gas cost. With SLASHER_REWARD_BPS=1000 (10%),
    // treasury gets 90% of the penalty, `other` (the caller) gets the
    // other 10% — see the dedicated "slasher reward" test below for the
    // precise reward-to-caller verification (gas-cost-adjusted).
    const expectedReward = (MIN_BOND * BigInt(SLASHER_REWARD_BPS)) / 10_000n;
    const expectedToTreasury = MIN_BOND - expectedReward;
    const treasuryBalBefore = await ethers.provider.getBalance(treasury.address);
    await expect(contract.connect(other).slashNoReveal(built.commitId))
      .to.emit(contract, "IntentSlashed")
      .withArgs(built.commitId, agent.address, MIN_BOND, expectedReward, other.address);

    expect(await contract.bondBalance(agent.address)).to.equal(0n);
    const treasuryBalAfter = await ethers.provider.getBalance(treasury.address);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(expectedToTreasury);

    // Cannot slash twice.
    await expect(contract.connect(other).slashNoReveal(built.commitId)).to.be.revertedWithCustomError(
      contract,
      "AlreadySlashed"
    );
  });

  it("pays the caller of slashNoReveal a reward, gas-cost-adjusted, not just the treasury", async function () {
    const { contract, agent, other } = await loadFixture(deploy);
    await alignToFreshEpoch(COMMIT_WINDOW);
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealCloseTimeOf(epoch));

    const expectedReward = (MIN_BOND * BigInt(SLASHER_REWARD_BPS)) / 10_000n;
    const otherBalBefore = await ethers.provider.getBalance(other.address);
    const tx = await contract.connect(other).slashNoReveal(built.commitId);
    const receipt = await tx.wait();
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    const otherBalAfter = await ethers.provider.getBalance(other.address);

    // other's balance change = +reward - gas it spent calling this itself.
    expect(otherBalAfter - otherBalBefore + gasCost).to.equal(expectedReward);
  });

  it("sends the whole penalty to treasury when slasherRewardBps is 0 (reward is opt-in, not forced)", async function () {
    const [treasury, agent, other, guardian] = await ethers.getSigners();
    const Contract = await ethers.getContractFactory("IntentCommitReveal");
    const contract = await Contract.deploy(
      COMMIT_WINDOW,
      REVEAL_DELAY,
      REVEAL_WINDOW,
      MIN_BOND,
      treasury.address,
      guardian.address,
      0 // slasherRewardBps
    );
    await contract.waitForDeployment();

    await alignToFreshEpoch(COMMIT_WINDOW);
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["swap 1 ETH -> USDC"]);
    const built = buildIntent(agent.address, intentData, 1);
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealCloseTimeOf(epoch));

    const treasuryBalBefore = await ethers.provider.getBalance(treasury.address);
    await expect(contract.connect(other).slashNoReveal(built.commitId))
      .to.emit(contract, "IntentSlashed")
      .withArgs(built.commitId, agent.address, MIN_BOND, 0n, other.address);
    const treasuryBalAfter = await ethers.provider.getBalance(treasury.address);
    expect(treasuryBalAfter - treasuryBalBefore).to.equal(MIN_BOND);
  });

  it("rejects slashing a commitId that was never committed", async function () {
    const { contract, other } = await loadFixture(deploy);
    const fakeId = ethers.keccak256(ethers.toUtf8Bytes("never-committed-either"));
    await expect(contract.connect(other).slashNoReveal(fakeId)).to.be.revertedWithCustomError(
      contract,
      "CommitNotFound"
    );
  });

  it("rejects slashing (and rejects reveal after being slashed) once a commitment is resolved either way", async function () {
    const { contract, executor, agent, other } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });

    // Commitment #1: gets revealed normally -> slashing it afterward must fail.
    const dataRevealed = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["will be revealed"]);
    const builtRevealed = buildIntent(agent.address, dataRevealed, 1);
    await contract.connect(agent).commitIntent(builtRevealed.commitId, builtRevealed.commitHash);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealOpenTimeOf(epoch));
    await contract
      .connect(agent)
      .revealIntent(builtRevealed.commitId, builtRevealed.intentData, builtRevealed.salt, await executor.getAddress());

    await time.increaseTo(await contract.revealCloseTimeOf(epoch));
    await expect(contract.connect(other).slashNoReveal(builtRevealed.commitId)).to.be.revertedWithCustomError(
      contract,
      "AlreadyRevealed"
    );

    // Commitment #2: gets slashed -> revealing it afterward must fail with
    // AlreadySlashed, not fall through to a timing/hash check.
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    const dataSlashed = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["will be slashed"]);
    const builtSlashed = buildIntent(agent.address, dataSlashed, 2);
    await contract.connect(agent).commitIntent(builtSlashed.commitId, builtSlashed.commitHash);

    const epoch2 = await contract.currentEpoch();
    await time.increaseTo(await contract.revealCloseTimeOf(epoch2));
    await contract.connect(other).slashNoReveal(builtSlashed.commitId);

    await expect(
      contract
        .connect(agent)
        .revealIntent(builtSlashed.commitId, builtSlashed.intentData, builtSlashed.salt, await executor.getAddress())
    ).to.be.revertedWithCustomError(contract, "AlreadySlashed");
  });

  it("batches multiple agents' reveal windows together (the actual privacy property)", async function () {
    const { contract, executor, agent, other } = await loadFixture(deploy);
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    await contract.connect(other).depositBond({ value: MIN_BOND });

    const dataA = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["agentA intent"]);
    const dataB = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["agentB intent"]);
    const builtA = buildIntent(agent.address, dataA, 1);
    const builtB = buildIntent(other.address, dataB, 1);

    // Land at the start of a fresh epoch so both commits below are
    // guaranteed room to land in the same one, regardless of how many
    // seconds earlier setup (deploys, bond deposits) already consumed.
    await alignToFreshEpoch(COMMIT_WINDOW);

    // agent commits first...
    await contract.connect(agent).commitIntent(builtA.commitId, builtA.commitHash);
    // ...a bit of time passes...
    await time.increase(5);
    // ...then `other` commits later in the SAME epoch.
    const epochA = await contract.currentEpoch();
    await contract.connect(other).commitIntent(builtB.commitId, builtB.commitHash);
    const epochB = await contract.currentEpoch();
    expect(epochA).to.equal(epochB); // same batch

    const openTime = await contract.revealOpenTimeOf(epochA);
    await time.increaseTo(openTime);

    // Both can reveal starting from the exact same timestamp, regardless of
    // which one committed first — that's what removes the timing signal.
    await expect(
      contract.connect(agent).revealIntent(builtA.commitId, builtA.intentData, builtA.salt, await executor.getAddress())
    ).to.emit(contract, "IntentRevealed");
    await expect(
      contract.connect(other).revealIntent(builtB.commitId, builtB.intentData, builtB.salt, await executor.getAddress())
    ).to.emit(contract, "IntentRevealed");
  });

  describe("commitIntentViaRelay (Phase 3 extension: relayed/meta-tx commit)", function () {
    it("lets a third-party relay submit a commit the agent signed off-chain", async function () {
      const { contract, agent, other } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relayed commit"]);
      const built = buildIntent(agent.address, intentData, 1);

      const network = await ethers.provider.getNetwork();
      const { value, signature } = await signCommitRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );

      // `other` is the relay: pays gas, is msg.sender, but the commitment
      // is recorded against `agent`.
      const tx = await contract.connect(other).commitIntentViaRelay(built.commitId, built.commitHash, agent.address, value.deadline, signature);
      await expect(tx)
        .to.emit(contract, "IntentCommitted")
        .withArgs(
          built.commitId,
          agent.address,
          other.address,
          await contract.currentEpoch(),
          await contract.revealOpenTimeOf(await contract.currentEpoch()),
          await contract.revealCloseTimeOf(await contract.currentEpoch())
        );

      const stored = await contract.commitments(built.commitId);
      expect(stored.agent).to.equal(agent.address);
      expect(await contract.lockedBond(agent.address)).to.equal(MIN_BOND);
    });

    it("rejects a commit relay submission signed by the wrong account", async function () {
      const { contract, agent, other } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relayed commit wrong signer"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();

      // `other` signs but claims to be acting for `agent`.
      const { value, signature } = await signCommitRequest(
        other,
        network.chainId,
        contractAddr,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );

      await expect(
        contract.connect(other).commitIntentViaRelay(built.commitId, built.commitHash, agent.address, value.deadline, signature)
      ).to.be.revertedWithCustomError(contract, "InvalidSigner");
    });

    it("rejects a commit relay submission after its own deadline has passed", async function () {
      // Signs manually with a deadline computed from CHAIN time
      // (time.latest()), not signCommitRequest()'s wall-clock Date.now().
      // An earlier version of this test used signCommitRequest(..., 10)
      // (deadline = real Date.now() + 10s) followed by time.increase(11)
      // (chain time + 11s from wherever the fixture snapshot's clock
      // was) — a 1-second margin between two DIFFERENT clocks. That
      // reliably passed in isolation but was genuinely flaky in a full
      // suite run: enough real wall-clock time elapses running the other
      // ~47 tests before this one that Date.now() can already be ahead of
      // the fixture's chain-time snapshot by more than 1 second, silently
      // eating the margin and making the deadline not-yet-passed from the
      // chain's own perspective — reproduced locally (not hypothetical):
      // this exact test failed under `npm test` on a fresh compile.
      const { contract, agent, other } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relayed commit expiring"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();

      const deadline = BigInt((await time.latest()) + 5);
      const structValue = { commitId: built.commitId, commitHash: built.commitHash, agent: agent.address, deadline };
      const signature = await agent.signTypedData(domainFor(network.chainId, contractAddr), COMMIT_REQUEST_TYPES, structValue);

      await time.increase(100); // comfortably past `deadline`, entirely in chain-time terms

      await expect(
        contract.connect(other).commitIntentViaRelay(built.commitId, built.commitHash, agent.address, deadline, signature)
      ).to.be.revertedWithCustomError(contract, "SignatureExpired");
    });

    it("rejects reusing a commitId a second time via relay (same as direct commit)", async function () {
      const { contract, agent, other } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND * 2n });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relayed commit replay"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();

      const { value, signature } = await signCommitRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );

      await contract.connect(other).commitIntentViaRelay(built.commitId, built.commitHash, agent.address, value.deadline, signature);

      await expect(
        contract.connect(other).commitIntentViaRelay(built.commitId, built.commitHash, agent.address, value.deadline, signature)
      ).to.be.revertedWithCustomError(contract, "CommitAlreadyExists");
    });

    it("a fully-relayed commit can still be revealed directly by the agent afterward", async function () {
      // End-to-end sanity check that the two relay paths (commit and
      // reveal) compose correctly — an agent's wallet never has to touch
      // the chain for this commitment at all until it chooses to.
      const { contract, executor, agent, other } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["fully relayed"]);
      const built = buildIntent(agent.address, intentData, 1);
      const network = await ethers.provider.getNetwork();

      const { value: commitValue, signature: commitSig } = await signCommitRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.commitHash,
        DEADLINE_BUFFER
      );
      await contract
        .connect(other)
        .commitIntentViaRelay(built.commitId, built.commitHash, agent.address, commitValue.deadline, commitSig);

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealOpenTimeOf(epoch));

      const executorAddr = await executor.getAddress();
      await expect(
        contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, executorAddr)
      ).to.emit(contract, "IntentRevealed");
    });
  });

  describe("revealIntentViaRelay (Phase 3, partial: relayed/meta-tx reveal)", function () {
    async function setupCommitted() {
      const base = await loadFixture(deploy);
      const { contract, agent } = base;
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["relayed intent"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      const epoch = await contract.currentEpoch();
      const openTime = await contract.revealOpenTimeOf(epoch);
      await time.increaseTo(openTime);

      const network = await ethers.provider.getNetwork();
      return { ...base, built, network };
    }

    it("lets a third-party relay submit a reveal the agent signed off-chain", async function () {
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );

      // `other` is the relay here: NOT the agent, pays its own gas, and is
      // the on-chain msg.sender — yet the reveal is correctly attributed to
      // `agent`, which is the whole point of this mechanism.
      const tx = await contract
        .connect(other)
        .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, value.deadline, signature);

      await expect(tx)
        .to.emit(contract, "IntentRevealed")
        .withArgs(built.commitId, agent.address, executorAddr, other.address, true);
      await expect(tx).to.emit(executor, "Executed").withArgs(agent.address, built.intentData);

      const stored = await contract.commitments(built.commitId);
      expect(stored.revealed).to.equal(true);
    });

    it("rejects a relay submission signed by the wrong account", async function () {
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      // `other` signs, but claims to be acting for `agent` — signature won't
      // recover to `agent`, so this must revert.
      const { value, signature } = await signRevealRequest(
        other,
        network.chainId,
        contractAddr,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );

      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, value.deadline, signature)
      ).to.be.revertedWithCustomError(contract, "InvalidSigner");
    });

    it("rejects a relay submission after the signature's own deadline has passed", async function () {
      // Signs manually with a chain-time-based deadline instead of
      // signRevealRequest()'s wall-clock Date.now() — see the equivalent
      // commit-side test above for why: the old (10s deadline, then
      // time.increase(11)) pattern mixed two different clocks with only a
      // 1-second margin, and was reproducibly flaky in a full suite run
      // once enough real wall-clock time had elapsed running the other
      // tests first.
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      const deadline = BigInt((await time.latest()) + 5);
      const structValue = {
        commitId: built.commitId,
        intentDataHash: ethers.keccak256(built.intentData),
        salt: built.salt,
        executor: executorAddr,
        agent: agent.address,
        deadline,
      };
      const signature = await agent.signTypedData(domainFor(network.chainId, contractAddr), REVEAL_REQUEST_TYPES, structValue);

      await time.increase(100); // comfortably past `deadline`, entirely in chain-time terms

      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, deadline, signature)
      ).to.be.revertedWithCustomError(contract, "SignatureExpired");
    });

    it("a relayed reveal cannot be replayed a second time", async function () {
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );

      await contract
        .connect(other)
        .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, value.deadline, signature);

      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, value.deadline, signature)
      ).to.be.revertedWithCustomError(contract, "AlreadyRevealed");
    });

    it("rejects a malformed (wrong-length) signature", async function () {
      const { contract, executor, agent, other, built } = await setupCommitted();
      const executorAddr = await executor.getAddress();

      const malformedSignature = "0x1234"; // nowhere near 65 bytes
      const futureDeadline = (await time.latest()) + DEADLINE_BUFFER; // chain time, not wall-clock Date.now()
      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(
            built.commitId,
            built.intentData,
            built.salt,
            executorAddr,
            agent.address,
            futureDeadline,
            malformedSignature
          )
      ).to.be.revertedWithCustomError(contract, "InvalidSignatureLength");
    });

    it("rejects a signature with an invalid v byte", async function () {
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );
      // Corrupt just the last byte (v) to something that's neither 27 nor 28.
      const corrupted = signature.slice(0, -2) + "00";

      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, value.deadline, corrupted)
      ).to.be.revertedWithCustomError(contract, "InvalidSignatureV");
    });

    it("rejects a deliberately non-canonical (high-s) signature", async function () {
      // The SDK always canonicalizes to low-s before returning a signature
      // (see sdk/relay.ts), so this test bypasses the SDK entirely and
      // hand-flips a valid signature to its malleable high-s twin to prove
      // the on-chain guard actually fires — not just that the SDK happens
      // to never trigger it.
      const { contract, executor, agent, other, built, network } = await setupCommitted();
      const executorAddr = await executor.getAddress();
      const contractAddr = await contract.getAddress();

      const { value, signature } = await signRevealRequest(
        agent,
        network.chainId,
        contractAddr,
        built.commitId,
        built.intentData,
        built.salt,
        executorAddr,
        DEADLINE_BUFFER
      );

      const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const sig = ethers.Signature.from(signature);
      const flippedS = SECP256K1_N - BigInt(sig.s);
      const flippedV = sig.v === 27 ? 28 : 27;
      // ethers' own Signature class refuses to construct a non-canonical
      // (high-s) signature object at all (throws "non-canonical s"), so the
      // raw 65-byte signature is built here by direct hex concatenation —
      // bypassing ethers' own validation entirely, the same way a hostile
      // caller could construct arbitrary calldata bypassing any client-side
      // library's opinions. The contract must be the one rejecting this,
      // not ethers on our behalf.
      const rHex = sig.r.slice(2).padStart(64, "0");
      const sHex = flippedS.toString(16).padStart(64, "0");
      const vHex = flippedV.toString(16).padStart(2, "0");
      const highSSignature = "0x" + rHex + sHex + vHex;
      expect(highSSignature.length).to.equal(2 + 65 * 2); // sanity: still exactly 65 bytes

      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(
            built.commitId,
            built.intentData,
            built.salt,
            executorAddr,
            agent.address,
            value.deadline,
            highSSignature
          )
      ).to.be.revertedWithCustomError(contract, "InvalidSignatureS");
    });

    it("rejects a structurally-valid but cryptographically-invalid signature (r=0, ecrecover returns the zero address)", async function () {
      // Closes a coverage gap that was previously left undertested with
      // "impractical to force deliberately" as the excuse. It wasn't
      // actually impractical — r=0 is not a valid x-coordinate on
      // secp256k1, and Solidity's ecrecover precompile returns address(0)
      // for such structurally-invalid-but-correctly-shaped inputs rather
      // than reverting, which is exactly the case _recoverSigner's
      // `if (signer == address(0))` guard exists for.
      const { contract, executor, agent, other, built } = await setupCommitted();
      const executorAddr = await executor.getAddress();

      const rHex = "0".repeat(64); // r = 0: not a valid curve point
      const sHex = "1".padStart(64, "0"); // s = 1: comfortably within the valid low-s range
      const vHex = (27).toString(16).padStart(2, "0");
      const invalidSignature = "0x" + rHex + sHex + vHex;
      expect(invalidSignature.length).to.equal(2 + 65 * 2);

      const futureDeadline = (await time.latest()) + DEADLINE_BUFFER;
      await expect(
        contract
          .connect(other)
          .revealIntentViaRelay(built.commitId, built.intentData, built.salt, executorAddr, agent.address, futureDeadline, invalidSignature)
      ).to.be.revertedWithCustomError(contract, "InvalidSigner");
    });
  });

  describe("reentrancy (deliberately trying to break the contract, not just asserting it's safe)", function () {
    it("withdrawBond cannot be drained via the classic receive()-reentrancy pattern", async function () {
      const { contract } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();

      const Attacker = await ethers.getContractFactory("ReentrantAttacker");
      const attacker = await Attacker.deploy(contractAddr);
      await attacker.waitForDeployment();
      const attackerAddr = await attacker.getAddress();

      // Fund the attacker contract with exactly minBond, deposit it as its
      // own bond, same as any legitimate agent would.
      const [funder] = await ethers.getSigners();
      await funder.sendTransaction({ to: attackerAddr, value: MIN_BOND });
      await attacker.deposit();
      expect(await contract.bondBalance(attackerAddr)).to.equal(MIN_BOND);

      const contractBalBefore = await ethers.provider.getBalance(contractAddr);

      // Attempt to withdraw the full bond — receive() is configured to try
      // withdrawing again up to 3 times, but in practice only gets to try
      // ONCE: withdrawBond() zeroes the balance before sending ETH, so the
      // very first reentrant call already sees balance=0 and reverts before
      // it can even reach a second ETH transfer to recurse further. That
      // early, one-shot failure — not 3 blocked attempts — is itself the
      // proof checks-effects-interactions is working correctly here.
      await attacker.attack(MIN_BOND);

      expect(await attacker.reentryAttempts()).to.equal(1);
      expect(await attacker.reentrySuccesses()).to.equal(0);
      expect(await contract.bondBalance(attackerAddr)).to.equal(0n);
      expect(await ethers.provider.getBalance(attackerAddr)).to.equal(MIN_BOND);

      const contractBalAfter = await ethers.provider.getBalance(contractAddr);
      expect(contractBalBefore - contractBalAfter).to.equal(MIN_BOND); // exactly one payout left the contract, not more
    });

    it("a malicious executor cannot reenter revealIntent to double-execute the same commitment", async function () {
      const { contract, agent } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const MaliciousExecutorFactory = await ethers.getContractFactory("MaliciousExecutor");
      const malExecutor = await MaliciousExecutorFactory.deploy();
      await malExecutor.waitForDeployment();
      const malExecutorAddr = await malExecutor.getAddress();

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["reentrancy target"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealOpenTimeOf(epoch));

      // Configure the malicious executor to try reveal-ing the SAME
      // commitId again, from inside its own executeIntent() callback.
      const reentryCalldata = contract.interface.encodeFunctionData("revealIntent", [
        built.commitId,
        built.intentData,
        built.salt,
        malExecutorAddr,
      ]);
      await malExecutor.setReentry(contractAddr, reentryCalldata);

      // The outer, legitimate reveal should still succeed...
      const tx = await contract
        .connect(agent)
        .revealIntent(built.commitId, built.intentData, built.salt, malExecutorAddr);
      await expect(tx).to.emit(contract, "IntentRevealed");

      // ...but the reentrant attempt inside executeIntent() must have failed
      // (state was already flipped to revealed=true before the external
      // call, per checks-effects-interactions).
      expect(await malExecutor.reentrySucceeded()).to.equal(false);

      const stored = await contract.commitments(built.commitId);
      expect(stored.revealed).to.equal(true);
    });

    it("a malicious slasher cannot reenter slashNoReveal from its own reward payout to double-slash", async function () {
      const { contract, agent } = await loadFixture(deploy);
      const contractAddr = await contract.getAddress();
      await alignToFreshEpoch(COMMIT_WINDOW);
      await contract.connect(agent).depositBond({ value: MIN_BOND });
      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["reentrant slasher target"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealCloseTimeOf(epoch));

      const Slasher = await ethers.getContractFactory("ReentrantSlasher");
      const slasher = await Slasher.deploy(contractAddr);
      await slasher.waitForDeployment();

      const contractBalBefore = await ethers.provider.getBalance(contractAddr);
      await slasher.attack(built.commitId);

      // Reentrant attempt must have reverted (AlreadySlashed) — state was
      // flipped before either external transfer, per checks-effects-
      // interactions — so only ONE reward + ONE treasury payout ever left
      // the contract, not two.
      expect(await slasher.reentryReverted()).to.equal(true);
      expect((await contract.commitments(built.commitId)).slashed).to.equal(true);
      const contractBalAfter = await ethers.provider.getBalance(contractAddr);
      expect(contractBalBefore - contractBalAfter).to.equal(MIN_BOND); // exactly one commitment's penalty left, not more
    });
  });

  describe("bond locking (fix for the withdraw-before-slash gap)", function () {
    it("FIXED: an agent can no longer withdraw bond that's reserved against a pending commitment", async function () {
      // Earlier version of this contract let an agent commit, immediately
      // withdraw its entire bond in the very next transaction, and never
      // reveal — slashNoReveal() would then find bondBalance already at 0
      // and slash nothing, defeating the whole point of requiring a bond.
      // Caught by a test that PASSED against the old code (proving the gap
      // was real), and is now flipped to prove the gap is closed.
      const { contract, agent } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["griefing attempt"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      expect(await contract.lockedBond(agent.address)).to.equal(MIN_BOND);

      // The withdrawal that used to succeed must now be rejected.
      await expect(
        contract.connect(agent).withdrawBond(MIN_BOND)
      ).to.be.revertedWithCustomError(contract, "InsufficientFreeBond");
    });

    it("releases the lock (and allows withdrawal again) once the commitment is actually revealed", async function () {
      const { contract, executor, agent } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["normal flow"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);
      expect(await contract.lockedBond(agent.address)).to.equal(MIN_BOND);

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealOpenTimeOf(epoch));
      await contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, await executor.getAddress());

      expect(await contract.lockedBond(agent.address)).to.equal(0n);
      await expect(contract.connect(agent).withdrawBond(MIN_BOND)).to.not.be.reverted;
    });

    it("still allows slashNoReveal to take the full minBond penalty now that withdrawal can't drain it first", async function () {
      const { contract, agent, treasury, other } = await loadFixture(deploy);
      await contract.connect(agent).depositBond({ value: MIN_BOND });

      const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["ghost intent 2"]);
      const built = buildIntent(agent.address, intentData, 1);
      await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

      const epoch = await contract.currentEpoch();
      await time.increaseTo(await contract.revealCloseTimeOf(epoch));

      const expectedReward = (MIN_BOND * BigInt(SLASHER_REWARD_BPS)) / 10_000n;
      const treasuryBalBefore = await ethers.provider.getBalance(treasury.address);
      await expect(contract.connect(other).slashNoReveal(built.commitId))
        .to.emit(contract, "IntentSlashed")
        .withArgs(built.commitId, agent.address, MIN_BOND, expectedReward, other.address); // full penalty now, not 0
      const treasuryBalAfter = await ethers.provider.getBalance(treasury.address);

      expect(treasuryBalAfter - treasuryBalBefore).to.equal(MIN_BOND - expectedReward);
      expect(await contract.lockedBond(agent.address)).to.equal(0n); // released after slash too
    });

    it("scales the required bond with multiple concurrent pending commitments", async function () {
      const { contract, agent } = await loadFixture(deploy);
      // Deposit enough for exactly 2 concurrent commitments.
      await contract.connect(agent).depositBond({ value: MIN_BOND * 2n });

      const dataA = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["first"]);
      const dataB = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["second"]);
      const builtA = buildIntent(agent.address, dataA, 1);
      const builtB = buildIntent(agent.address, dataB, 2);

      await contract.connect(agent).commitIntent(builtA.commitId, builtA.commitHash);
      await contract.connect(agent).commitIntent(builtB.commitId, builtB.commitHash);
      expect(await contract.lockedBond(agent.address)).to.equal(MIN_BOND * 2n);

      // A third commitment must fail — no unlocked bond left to cover it.
      const dataC = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["third"]);
      const builtC = buildIntent(agent.address, dataC, 3);
      await expect(
        contract.connect(agent).commitIntent(builtC.commitId, builtC.commitHash)
      ).to.be.revertedWithCustomError(contract, "BondTooLow");
    });
  });
});
