import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time, takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

describe("AncillaVoteEscrow", function () {
  const CAP = ethers.parseEther("1000000");
  const MIN_LOCK = 4 * 7 * 24 * 60 * 60; // 4 weeks in seconds
  const MAX_LOCK = 104 * 7 * 24 * 60 * 60; // 104 weeks

  // MAX_LOCK is ~2 real years of simulated chain time — tests here that
  // time.increase() past a lock's maturity permanently move the shared
  // Hardhat node's clock forward by that much, and unlike loadFixture's
  // own per-fixture snapshot/revert, that displacement is NOT undone
  // before mocha moves on to the next test FILE in the same run. Real
  // bug this surfaced: relay-server.test.ts (and IntentCommitReveal's
  // helpers) sign requests with a deadline computed from real
  // Date.now() plus a buffer (1,000,000 seconds) specifically sized to
  // tolerate small clock drift between real time and the simulated
  // chain's block.timestamp — a multi-week-to-2-year jump blew straight
  // through that buffer and made otherwise-unrelated relay-server tests
  // fail with SignatureExpired further down the SAME `npx hardhat test`
  // run. A whole-file snapshot/restore guarantees this file's time
  // manipulation never leaks past its own tests, regardless of how large.
  let fileSnapshot: SnapshotRestorer;
  before(async function () {
    fileSnapshot = await takeSnapshot();
  });
  after(async function () {
    await fileSnapshot.restore();
  });

  async function deploy() {
    const [owner, alice, bob, funder] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AncillaToken");
    const token = await Token.deploy(CAP, owner.address);
    await token.waitForDeployment();

    const Escrow = await ethers.getContractFactory("AncillaVoteEscrow");
    const escrow = await Escrow.deploy(await token.getAddress());
    await escrow.waitForDeployment();
    const escrowAddress = await escrow.getAddress();

    await token.connect(owner).mint(alice.address, ethers.parseEther("1000"));
    await token.connect(owner).mint(bob.address, ethers.parseEther("1000"));
    await token.connect(alice).approve(escrowAddress, ethers.MaxUint256);
    await token.connect(bob).approve(escrowAddress, ethers.MaxUint256);

    return { token, escrow, escrowAddress, owner, alice, bob, funder };
  }

  async function fundWith(funder: any, escrowAddress: string, amountEth: string) {
    return funder.sendTransaction({ to: escrowAddress, value: ethers.parseEther(amountEth) });
  }

  describe("lock", function () {
    it("a max-duration lock gets the full amount as weight", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      const tx = await escrow.connect(alice).lock(amount, MAX_LOCK);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt!.blockNumber);
      await expect(tx)
        .to.emit(escrow, "Locked")
        .withArgs(alice.address, amount, BigInt(block!.timestamp) + BigInt(MAX_LOCK), amount);
      const l = await escrow.locks(alice.address);
      expect(l.weight).to.equal(amount);
      expect(await escrow.totalWeight()).to.equal(amount);
    });

    it("a lock at 1/4 of MAX_LOCK duration gets exactly 1/4 the weight of the same amount at max", async function () {
      const { escrow, alice, bob } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      const quarterLock = MAX_LOCK / 4;
      await escrow.connect(alice).lock(amount, quarterLock);
      await escrow.connect(bob).lock(amount, MAX_LOCK);
      const aliceLock = await escrow.locks(alice.address);
      const bobLock = await escrow.locks(bob.address);
      expect(bobLock.weight).to.equal(aliceLock.weight * 4n);
    });

    it("moves the actual ANCILLA tokens into the contract", async function () {
      const { token, escrow, escrowAddress, alice } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      await escrow.connect(alice).lock(amount, MAX_LOCK);
      expect(await token.balanceOf(escrowAddress)).to.equal(amount);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("900"));
    });

    it("rejects a lock shorter than MIN_LOCK", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await expect(escrow.connect(alice).lock(ethers.parseEther("1"), MIN_LOCK - 1)).to.be.revertedWithCustomError(
        escrow,
        "LockTooShort"
      );
    });

    it("rejects a lock longer than MAX_LOCK", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await expect(escrow.connect(alice).lock(ethers.parseEther("1"), MAX_LOCK + 1)).to.be.revertedWithCustomError(
        escrow,
        "LockTooLong"
      );
    });

    it("rejects locking zero", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await expect(escrow.connect(alice).lock(0, MAX_LOCK)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
    });

    it("rejects a second lock while one is already active", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await escrow.connect(alice).lock(ethers.parseEther("10"), MAX_LOCK);
      await expect(escrow.connect(alice).lock(ethers.parseEther("10"), MAX_LOCK)).to.be.revertedWithCustomError(
        escrow,
        "LockAlreadyActive"
      );
    });
  });

  describe("withdraw", function () {
    it("rejects withdrawing before the lock matures", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await escrow.connect(alice).lock(ethers.parseEther("10"), MIN_LOCK);
      await expect(escrow.connect(alice).withdraw()).to.be.revertedWithCustomError(escrow, "LockNotMatured");
    });

    it("rejects withdrawing with no active lock", async function () {
      const { escrow, alice } = await loadFixture(deploy);
      await expect(escrow.connect(alice).withdraw()).to.be.revertedWithCustomError(escrow, "NoActiveLock");
    });

    it("returns the exact principal once matured, and drops totalWeight", async function () {
      const { token, escrow, alice } = await loadFixture(deploy);
      const amount = ethers.parseEther("50");
      await escrow.connect(alice).lock(amount, MIN_LOCK);
      await time.increase(MIN_LOCK + 1);
      await expect(escrow.connect(alice).withdraw()).to.emit(escrow, "Withdrawn").withArgs(alice.address, amount);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("1000")); // back to the original mint
      expect(await escrow.totalWeight()).to.equal(0);
    });
  });

  describe("revenue distribution — weighted by commitment, not just amount", function () {
    it("reverts a plain ETH transfer if nobody has an active lock yet", async function () {
      const { escrow, escrowAddress, funder } = await loadFixture(deploy);
      await expect(fundWith(funder, escrowAddress, "1")).to.be.revertedWithCustomError(escrow, "NoLockersYet");
    });

    it("equal amounts, unequal lock durations: the longer lock earns proportionally more of the SAME distribution", async function () {
      const { escrow, escrowAddress, alice, bob, funder } = await loadFixture(deploy);
      const amount = ethers.parseEther("100");
      await escrow.connect(alice).lock(amount, MAX_LOCK / 4); // 1x weight unit
      await escrow.connect(bob).lock(amount, MAX_LOCK); // 4x weight unit
      // total weight = 5 units -> alice gets 1/5, bob gets 4/5 of the SAME 100 ANCILLA staked each
      await fundWith(funder, escrowAddress, "5");
      expect(await escrow.earned(alice.address)).to.equal(ethers.parseEther("1"));
      expect(await escrow.earned(bob.address)).to.equal(ethers.parseEther("4"));
    });

    it("claim() pays the exact accrued ETH, verified via real balance delta", async function () {
      const { escrow, escrowAddress, alice, funder } = await loadFixture(deploy);
      await escrow.connect(alice).lock(ethers.parseEther("100"), MAX_LOCK);
      await fundWith(funder, escrowAddress, "2");

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await escrow.connect(alice).claim();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before + gasCost).to.equal(ethers.parseEther("2"));
      expect(await escrow.earned(alice.address)).to.equal(0);
    });

    it("withdrawing a matured lock does not forfeit already-accrued rewards", async function () {
      const { escrow, alice, funder, escrowAddress } = await loadFixture(deploy);
      // MAX_LOCK, not MIN_LOCK: weight = amount * MAX_LOCK / MAX_LOCK is
      // exact, with no integer-division rounding remainder to muddy this
      // test's actual point (that a withdrawal preserves accrued rewards).
      await escrow.connect(alice).lock(ethers.parseEther("100"), MAX_LOCK);
      await fundWith(funder, escrowAddress, "1");
      await time.increase(MAX_LOCK + 1);
      await escrow.connect(alice).withdraw();
      expect(await escrow.earned(alice.address)).to.equal(ethers.parseEther("1"));
    });
  });
});
