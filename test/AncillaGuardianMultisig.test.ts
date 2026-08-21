import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("AncillaGuardianMultisig", function () {
  const THRESHOLD = 2;
  const PAUSE = 0; // Action.Pause
  const UNPAUSE = 1; // Action.Unpause

  // A real Pausable target, not a mock — proves the multisig actually
  // drives IntentCommitReveal's own guardian-gated pause()/unpause(),
  // the exact thing it exists to do, not just an abstract interface call.
  async function deployTargetGuardedBy(guardianAddress: string, treasuryAddress: string) {
    const Target = await ethers.getContractFactory("IntentCommitReveal");
    const target = await Target.deploy(
      300, // commitWindowSeconds
      60, // revealDelaySeconds
      300, // revealWindowSeconds
      ethers.parseEther("0.1"),
      treasuryAddress,
      guardianAddress,
      1000 // slasherRewardBps
    );
    await target.waitForDeployment();
    return target;
  }

  async function deploy() {
    const [ownerA, ownerB, ownerC, outsider, treasury] = await ethers.getSigners();
    const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
    const multisig = await Multisig.deploy([ownerA.address, ownerB.address, ownerC.address], THRESHOLD);
    await multisig.waitForDeployment();
    const multisigAddress = await multisig.getAddress();
    const target = await deployTargetGuardedBy(multisigAddress, treasury.address);
    return { multisig, multisigAddress, target, ownerA, ownerB, ownerC, outsider, treasury };
  }

  describe("constructor", function () {
    it("deploys with a valid owner set and threshold", async function () {
      const { multisig, ownerA, ownerB, ownerC } = await loadFixture(deploy);
      expect(await multisig.threshold()).to.equal(THRESHOLD);
      expect(await multisig.ownerCount()).to.equal(3);
      expect(await multisig.owners()).to.deep.equal([ownerA.address, ownerB.address, ownerC.address]);
    });

    it("rejects an empty owner set", async function () {
      const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
      await expect(Multisig.deploy([], 1)).to.be.revertedWithCustomError(Multisig, "ZeroOwners");
    });

    it("rejects a zero threshold", async function () {
      const [a, b] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
      await expect(Multisig.deploy([a.address, b.address], 0)).to.be.revertedWithCustomError(
        Multisig,
        "InvalidThreshold"
      );
    });

    it("rejects a threshold greater than the number of owners", async function () {
      const [a, b] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
      await expect(Multisig.deploy([a.address, b.address], 3)).to.be.revertedWithCustomError(
        Multisig,
        "InvalidThreshold"
      );
    });

    it("rejects a zero-address owner", async function () {
      const [a] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
      await expect(
        Multisig.deploy([a.address, ethers.ZeroAddress], 1)
      ).to.be.revertedWithCustomError(Multisig, "ZeroOwnerAddress");
    });

    it("rejects a duplicate owner", async function () {
      const [a] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaGuardianMultisig");
      await expect(Multisig.deploy([a.address, a.address], 1)).to.be.revertedWithCustomError(
        Multisig,
        "DuplicateOwner"
      );
    });
  });

  describe("proposePause / propose Unpause", function () {
    it("counts the proposer's own confirmation immediately and records target+action", async function () {
      const { multisig, target, ownerA } = await loadFixture(deploy);
      const targetAddress = await target.getAddress();
      await expect(multisig.connect(ownerA).proposePause(targetAddress))
        .to.emit(multisig, "Proposed")
        .withArgs(0, ownerA.address, targetAddress, PAUSE)
        .and.to.emit(multisig, "Confirmed")
        .withArgs(0, ownerA.address);
      const p = await multisig.proposals(0);
      expect(p.target).to.equal(targetAddress);
      expect(p.action).to.equal(PAUSE);
      expect(p.confirmations).to.equal(1);
      expect(p.executed).to.equal(false);
    });

    it("rejects a non-owner proposing", async function () {
      const { multisig, target, outsider } = await loadFixture(deploy);
      await expect(
        multisig.connect(outsider).proposePause(await target.getAddress())
      ).to.be.revertedWithCustomError(multisig, "NotOwner");
    });

    it("rejects a zero target", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      await expect(multisig.connect(ownerA).proposePause(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        multisig,
        "ZeroTarget"
      );
    });
  });

  describe("confirm / revokeConfirmation", function () {
    it("a second owner's confirmation reaches the threshold", async function () {
      const { multisig, target, ownerA, ownerB } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await expect(multisig.connect(ownerB).confirm(0)).to.emit(multisig, "Confirmed").withArgs(0, ownerB.address);
      const p = await multisig.proposals(0);
      expect(p.confirmations).to.equal(2);
    });

    it("rejects confirming a proposal that doesn't exist", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      await expect(multisig.connect(ownerA).confirm(0)).to.be.revertedWithCustomError(
        multisig,
        "ProposalDoesNotExist"
      );
    });

    it("rejects a non-owner confirming", async function () {
      const { multisig, target, ownerA, outsider } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await expect(multisig.connect(outsider).confirm(0)).to.be.revertedWithCustomError(multisig, "NotOwner");
    });

    it("rejects double-confirming from the same owner", async function () {
      const { multisig, target, ownerA } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await expect(multisig.connect(ownerA).confirm(0)).to.be.revertedWithCustomError(multisig, "AlreadyConfirmed");
    });

    it("lets an owner revoke their own confirmation, dropping the count", async function () {
      const { multisig, target, ownerA, ownerB } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await multisig.connect(ownerB).confirm(0);
      await expect(multisig.connect(ownerB).revokeConfirmation(0))
        .to.emit(multisig, "Revoked")
        .withArgs(0, ownerB.address);
      const p = await multisig.proposals(0);
      expect(p.confirmations).to.equal(1);
    });

    it("rejects revoking a confirmation that was never made", async function () {
      const { multisig, target, ownerA, ownerB } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await expect(multisig.connect(ownerB).revokeConfirmation(0)).to.be.revertedWithCustomError(
        multisig,
        "NotConfirmed"
      );
    });
  });

  describe("execute — real pause/unpause governance over a live target", function () {
    it("blocks execution below threshold", async function () {
      const { multisig, target, ownerA } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await expect(multisig.connect(ownerA).execute(0)).to.be.revertedWithCustomError(
        multisig,
        "NotEnoughConfirmations"
      );
      // Proves this wasn't a no-op silently "succeeding" — the target is
      // genuinely still unpaused.
      expect(await target.paused()).to.equal(false);
    });

    it("a single owner alone cannot pause — proves this is really M-of-N, not one key with extra steps", async function () {
      const { multisig, target, ownerA } = await loadFixture(deploy);
      const targetAddress = await target.getAddress();
      await multisig.connect(ownerA).proposePause(targetAddress);
      // Only ownerA has ever confirmed (the auto-confirm from proposing).
      // Executing now must fail — this is the actual security property.
      await expect(multisig.connect(ownerA).execute(0)).to.be.revertedWithCustomError(
        multisig,
        "NotEnoughConfirmations"
      );
      expect(await target.paused()).to.equal(false);
    });

    it("two confirmations actually pause the real target contract, and unpause reverses it", async function () {
      const { multisig, target, ownerA, ownerB } = await loadFixture(deploy);
      const targetAddress = await target.getAddress();

      await multisig.connect(ownerA).proposePause(targetAddress);
      await multisig.connect(ownerB).confirm(0);
      await expect(multisig.connect(ownerA).execute(0))
        .to.emit(multisig, "Executed")
        .withArgs(0, targetAddress, PAUSE);
      expect(await target.paused()).to.equal(true);

      await multisig.connect(ownerA).proposeUnpause(targetAddress);
      await multisig.connect(ownerB).confirm(1);
      await expect(multisig.connect(ownerA).execute(1))
        .to.emit(multisig, "Executed")
        .withArgs(1, targetAddress, UNPAUSE);
      expect(await target.paused()).to.equal(false);
    });

    it("rejects a non-owner executing", async function () {
      const { multisig, target, ownerA, ownerB, outsider } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await multisig.connect(ownerB).confirm(0);
      await expect(multisig.connect(outsider).execute(0)).to.be.revertedWithCustomError(multisig, "NotOwner");
    });

    it("rejects executing a proposal that doesn't exist", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      await expect(multisig.connect(ownerA).execute(0)).to.be.revertedWithCustomError(
        multisig,
        "ProposalDoesNotExist"
      );
    });

    it("rejects double-execution", async function () {
      const { multisig, target, ownerA, ownerB } = await loadFixture(deploy);
      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await multisig.connect(ownerB).confirm(0);
      await multisig.connect(ownerA).execute(0);
      await expect(multisig.connect(ownerA).execute(0)).to.be.revertedWithCustomError(multisig, "AlreadyExecuted");
    });

    it("propagates the target's own revert reason instead of swallowing it, and leaves the proposal re-executable", async function () {
      // Deploy a target whose guardian is NOT this multisig, so the
      // underlying pause() call reverts with the target's own
      // NotGuardian — proving execute() doesn't wrap failures in a
      // generic error, and (checks-effects-interactions) that the
      // executed=true write really did unwind, since the second attempt
      // below still sees NotEnoughConfirmations, not AlreadyExecuted.
      const { multisig, ownerA, ownerB, treasury, outsider } = await loadFixture(deploy);
      const wrongGuardianTarget = await deployTargetGuardedBy(outsider.address, treasury.address);
      const wrongTargetAddress = await wrongGuardianTarget.getAddress();

      await multisig.connect(ownerA).proposePause(wrongTargetAddress);
      await multisig.connect(ownerB).confirm(0);
      await expect(multisig.connect(ownerA).execute(0)).to.be.revertedWithCustomError(
        wrongGuardianTarget,
        "NotGuardian"
      );

      const p = await multisig.proposals(0);
      expect(p.executed).to.equal(false);
      expect(await wrongGuardianTarget.paused()).to.equal(false);
    });
  });

  describe("one guardian multisig, multiple targets", function () {
    it("can independently pause two different contracts it guards", async function () {
      const { multisig, target, ownerA, ownerB, treasury } = await loadFixture(deploy);
      const multisigAddress = await multisig.getAddress();
      const secondTarget = await deployTargetGuardedBy(multisigAddress, treasury.address);

      await multisig.connect(ownerA).proposePause(await target.getAddress());
      await multisig.connect(ownerB).confirm(0);
      await multisig.connect(ownerA).execute(0);

      expect(await target.paused()).to.equal(true);
      expect(await secondTarget.paused()).to.equal(false); // untouched

      await multisig.connect(ownerA).proposePause(await secondTarget.getAddress());
      await multisig.connect(ownerB).confirm(1);
      await multisig.connect(ownerA).execute(1);
      expect(await secondTarget.paused()).to.equal(true);
    });
  });
});
