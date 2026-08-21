import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("AncillaTreasuryMultisig", function () {
  const THRESHOLD = 2;

  async function deploy() {
    const [ownerA, ownerB, ownerC, outsider, recipient] = await ethers.getSigners();
    const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
    const multisig = await Multisig.deploy(
      [ownerA.address, ownerB.address, ownerC.address],
      THRESHOLD
    );
    await multisig.waitForDeployment();
    return { multisig, ownerA, ownerB, ownerC, outsider, recipient };
  }

  async function fund(multisigAddress: string, funder: any, amountEth: string) {
    const tx = await funder.sendTransaction({
      to: multisigAddress,
      value: ethers.parseEther(amountEth),
    });
    await tx.wait();
  }

  describe("constructor", function () {
    it("deploys with a valid owner set and threshold", async function () {
      const { multisig, ownerA, ownerB, ownerC } = await loadFixture(deploy);
      expect(await multisig.threshold()).to.equal(THRESHOLD);
      expect(await multisig.ownerCount()).to.equal(3);
      expect(await multisig.isOwner(ownerA.address)).to.equal(true);
      expect(await multisig.isOwner(ownerB.address)).to.equal(true);
      expect(await multisig.isOwner(ownerC.address)).to.equal(true);
      expect(await multisig.owners()).to.deep.equal([ownerA.address, ownerB.address, ownerC.address]);
    });

    it("rejects an empty owner set", async function () {
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      await expect(Multisig.deploy([], 1)).to.be.revertedWithCustomError(Multisig, "ZeroOwners");
    });

    it("rejects a zero threshold", async function () {
      const [a, b] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      await expect(Multisig.deploy([a.address, b.address], 0)).to.be.revertedWithCustomError(
        Multisig,
        "InvalidThreshold"
      );
    });

    it("rejects a threshold greater than the number of owners", async function () {
      const [a, b] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      await expect(Multisig.deploy([a.address, b.address], 3)).to.be.revertedWithCustomError(
        Multisig,
        "InvalidThreshold"
      );
    });

    it("rejects a zero-address owner", async function () {
      const [a] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      await expect(
        Multisig.deploy([a.address, ethers.ZeroAddress], 1)
      ).to.be.revertedWithCustomError(Multisig, "ZeroOwnerAddress");
    });

    it("rejects a duplicate owner", async function () {
      const [a] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      await expect(Multisig.deploy([a.address, a.address], 1)).to.be.revertedWithCustomError(
        Multisig,
        "DuplicateOwner"
      );
    });

    it("allows a 1-of-1 multisig (degenerate but valid)", async function () {
      const [a] = await ethers.getSigners();
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");
      const m = await Multisig.deploy([a.address], 1);
      expect(await m.threshold()).to.equal(1);
    });
  });

  describe("receiving ETH", function () {
    it("accepts a plain ETH transfer and emits Deposited", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      const amount = ethers.parseEther("1");
      await expect(ownerA.sendTransaction({ to: await multisig.getAddress(), value: amount }))
        .to.emit(multisig, "Deposited")
        .withArgs(ownerA.address, amount);
      expect(await ethers.provider.getBalance(await multisig.getAddress())).to.equal(amount);
    });
  });

  describe("proposeWithdrawal", function () {
    it("counts the proposer's own confirmation immediately", async function () {
      const { multisig, ownerA, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      const amount = ethers.parseEther("0.4");
      await expect(multisig.connect(ownerA).proposeWithdrawal(recipient.address, amount))
        .to.emit(multisig, "WithdrawalProposed")
        .withArgs(0, ownerA.address, recipient.address, amount)
        .and.to.emit(multisig, "WithdrawalConfirmed")
        .withArgs(0, ownerA.address);
      const w = await multisig.withdrawals(0);
      expect(w.confirmations).to.equal(1);
      expect(w.executed).to.equal(false);
    });

    it("rejects a non-owner proposing a withdrawal", async function () {
      const { multisig, outsider, recipient } = await loadFixture(deploy);
      await expect(
        multisig.connect(outsider).proposeWithdrawal(recipient.address, 1)
      ).to.be.revertedWithCustomError(multisig, "NotOwner");
    });

    it("rejects a zero recipient", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      await expect(
        multisig.connect(ownerA).proposeWithdrawal(ethers.ZeroAddress, 0)
      ).to.be.revertedWithCustomError(multisig, "ZeroRecipient");
    });

    it("rejects an amount larger than the current balance", async function () {
      const { multisig, ownerA, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "0.1");
      await expect(
        multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(multisig, "InsufficientBalance");
    });
  });

  describe("confirmWithdrawal / revokeConfirmation", function () {
    it("a second owner's confirmation reaches the threshold", async function () {
      const { multisig, ownerA, ownerB, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await expect(multisig.connect(ownerB).confirmWithdrawal(0))
        .to.emit(multisig, "WithdrawalConfirmed")
        .withArgs(0, ownerB.address);
      const w = await multisig.withdrawals(0);
      expect(w.confirmations).to.equal(2);
    });

    it("rejects confirming a withdrawal that doesn't exist", async function () {
      const { multisig, ownerA } = await loadFixture(deploy);
      await expect(multisig.connect(ownerA).confirmWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "WithdrawalDoesNotExist"
      );
    });

    it("rejects a non-owner confirming", async function () {
      const { multisig, ownerA, outsider, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await expect(multisig.connect(outsider).confirmWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "NotOwner"
      );
    });

    it("rejects double-confirming from the same owner", async function () {
      const { multisig, ownerA, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await expect(multisig.connect(ownerA).confirmWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "AlreadyConfirmed"
      );
    });

    it("lets an owner revoke their own confirmation, dropping the count", async function () {
      const { multisig, ownerA, ownerB, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await multisig.connect(ownerB).confirmWithdrawal(0);
      await expect(multisig.connect(ownerB).revokeConfirmation(0))
        .to.emit(multisig, "WithdrawalRevoked")
        .withArgs(0, ownerB.address);
      const w = await multisig.withdrawals(0);
      expect(w.confirmations).to.equal(1);
    });

    it("rejects revoking a confirmation that was never given", async function () {
      const { multisig, ownerA, ownerC, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await expect(multisig.connect(ownerC).revokeConfirmation(0)).to.be.revertedWithCustomError(
        multisig,
        "NotConfirmed"
      );
    });

    it("rejects confirming or revoking once a withdrawal is already executed", async function () {
      const { multisig, ownerA, ownerB, ownerC, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await multisig.connect(ownerB).confirmWithdrawal(0);
      await multisig.connect(ownerA).executeWithdrawal(0);
      await expect(multisig.connect(ownerC).confirmWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "AlreadyExecuted"
      );
      await expect(multisig.connect(ownerA).revokeConfirmation(0)).to.be.revertedWithCustomError(
        multisig,
        "AlreadyExecuted"
      );
    });
  });

  describe("executeWithdrawal", function () {
    it("rejects execution before the threshold is met", async function () {
      const { multisig, ownerA, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await expect(multisig.connect(ownerA).executeWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "NotEnoughConfirmations"
      );
    });

    it("sends the exact amount once threshold confirmations are reached, verified by balance delta", async function () {
      const { multisig, ownerA, ownerB, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "2");
      const amount = ethers.parseEther("0.75");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, amount);
      await multisig.connect(ownerB).confirmWithdrawal(0);

      const before = await ethers.provider.getBalance(recipient.address);
      await expect(multisig.connect(ownerA).executeWithdrawal(0))
        .to.emit(multisig, "WithdrawalExecuted")
        .withArgs(0, recipient.address, amount);
      const after = await ethers.provider.getBalance(recipient.address);

      expect(after - before).to.equal(amount);
      expect((await multisig.withdrawals(0)).executed).to.equal(true);
      expect(await ethers.provider.getBalance(await multisig.getAddress())).to.equal(
        ethers.parseEther("1.25")
      );
    });

    it("rejects a non-owner executing, even with enough confirmations already in place", async function () {
      const { multisig, ownerA, ownerB, outsider, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await multisig.connect(ownerB).confirmWithdrawal(0);
      await expect(multisig.connect(outsider).executeWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "NotOwner"
      );
    });

    it("rejects double-execution of the same withdrawal", async function () {
      const { multisig, ownerA, ownerB, recipient } = await loadFixture(deploy);
      await fund(await multisig.getAddress(), ownerA, "1");
      await multisig.connect(ownerA).proposeWithdrawal(recipient.address, ethers.parseEther("0.5"));
      await multisig.connect(ownerB).confirmWithdrawal(0);
      await multisig.connect(ownerA).executeWithdrawal(0);
      await expect(multisig.connect(ownerA).executeWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "AlreadyExecuted"
      );
    });

    it("reverts (doesn't get stuck half-executed) if the transfer itself fails", async function () {
      // IMPORTANT: loadFixture() reverts chain state to the snapshot taken
      // the first time `deploy` ever ran — so anything deployed *before*
      // calling it here would get silently wiped out by that revert (its
      // address would end up with no code, and a plain ETH send to a
      // no-code address always "succeeds," defeating the whole point of
      // this test). Fixture first, then the extra mock.
      const { multisig, ownerA, ownerB } = await loadFixture(deploy);

      // A contract with no receive()/fallback refuses plain ETH transfers.
      // Its constructor wants a `target` address (it's designed to attack
      // IntentCommitReveal elsewhere) — unused here, any address will do.
      const Rejecting = await ethers.getContractFactory("RejectingReceiver");
      const rejecting = await Rejecting.deploy(ethers.ZeroAddress);
      await rejecting.waitForDeployment();
      await fund(await multisig.getAddress(), ownerA, "1");
      const amount = ethers.parseEther("0.5");
      await multisig.connect(ownerA).proposeWithdrawal(await rejecting.getAddress(), amount);
      await multisig.connect(ownerB).confirmWithdrawal(0);

      await expect(multisig.connect(ownerA).executeWithdrawal(0)).to.be.revertedWithCustomError(
        multisig,
        "TransferFailed"
      );
      // Reverted entirely — not left half-executed — so the same withdrawal
      // can still be retried (e.g. against a corrected recipient) later.
      expect((await multisig.withdrawals(0)).executed).to.equal(false);
      expect(await ethers.provider.getBalance(await multisig.getAddress())).to.equal(
        ethers.parseEther("1")
      );
    });
  });

  describe("reentrancy (deliberately trying to break it, not just asserting it's safe)", function () {
    it("cannot be reentered from the withdrawal recipient's own receive() hook to double-spend", async function () {
      const [ownerA, ownerB] = await ethers.getSigners();
      const Attacker = await ethers.getContractFactory("ReentrantTreasuryOwner");
      // Deploy the multisig itself first isn't possible before the attacker
      // exists (attacker needs the multisig's address), and the multisig
      // needs the attacker's address as a listed owner — so deploy the
      // multisig with a placeholder set first is not an option either,
      // since owners are immutable. Deploy multisig with [ownerA, ownerB,
      // attacker-address-computed-in-advance] via CREATE nonce is overkill;
      // simplest: deploy attacker with a not-yet-deployed multisig address
      // is impossible too. Instead: make the attacker deployable standalone
      // (it only needs the multisig's address in its constructor), so
      // deploy multisig FIRST with [ownerA, ownerB, <attacker address>]
      // computed via a dry-run is unnecessary — just deploy the multisig
      // with ownerA/ownerB/attacker in one step isn't possible since
      // attacker's constructor needs the multisig address.
      //
      // Resolution used here: deploy the multisig with only ownerA/ownerB
      // as owners (threshold 2), and have the *recipient* of the
      // withdrawal be the attacker contract even though it isn't an owner.
      // Reentrancy risk doesn't require the attacker to be an owner at
      // all — it only needs `executeWithdrawal` to be callable by *some*
      // owner while ETH is in flight to it. ownerA re-executing from
      // outside is what proves the guard; the attacker's receive() tries
      // to call executeWithdrawal itself, which onlyOwner alone would
      // already block — so to test the *reentrancy guard specifically*
      // (not just onlyOwner), the attacker is made an owner too.
      const Multisig = await ethers.getContractFactory("AncillaTreasuryMultisig");

      // Predict the attacker's deployment address so it can be listed as
      // an owner of the multisig deployed just before it.
      const deployerAddress = ownerA.address;
      const nonce = await ethers.provider.getTransactionCount(deployerAddress);
      const predictedAttackerAddress = ethers.getCreateAddress({ from: deployerAddress, nonce: nonce + 1 });

      const multisig = await Multisig.deploy([ownerA.address, ownerB.address, predictedAttackerAddress], 2);
      await multisig.waitForDeployment();

      const attacker = await Attacker.deploy(await multisig.getAddress());
      await attacker.waitForDeployment();
      expect(await attacker.getAddress()).to.equal(predictedAttackerAddress);
      expect(await multisig.isOwner(predictedAttackerAddress)).to.equal(true);

      await fund(await multisig.getAddress(), ownerA, "1");
      const amount = ethers.parseEther("0.3");
      await multisig.connect(ownerA).proposeWithdrawal(await attacker.getAddress(), amount);
      await multisig.connect(ownerB).confirmWithdrawal(0);
      await attacker.arm(0);

      const before = await ethers.provider.getBalance(await attacker.getAddress());
      await multisig.connect(ownerA).executeWithdrawal(0);
      const after = await ethers.provider.getBalance(await attacker.getAddress());

      // Exactly one withdrawal's worth arrived — not two — and the
      // reentrant call the attacker made from receive() reverted.
      expect(after - before).to.equal(amount);
      expect(await attacker.reentryReverted()).to.equal(true);
      expect((await multisig.withdrawals(0)).executed).to.equal(true);
      expect(await multisig.withdrawalCount()).to.equal(1); // no second withdrawal was ever created
    });
  });
});
