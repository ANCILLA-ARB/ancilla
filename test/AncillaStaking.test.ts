import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("AncillaStaking", function () {
  const CAP = ethers.parseEther("1000000");

  async function deploy() {
    const [owner, alice, bob, funder] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AncillaToken");
    const token = await Token.deploy(CAP, owner.address);
    await token.waitForDeployment();

    const Staking = await ethers.getContractFactory("AncillaStaking");
    const staking = await Staking.deploy(await token.getAddress());
    await staking.waitForDeployment();
    const stakingAddress = await staking.getAddress();

    await token.connect(owner).mint(alice.address, ethers.parseEther("1000"));
    await token.connect(owner).mint(bob.address, ethers.parseEther("1000"));
    await token.connect(alice).approve(stakingAddress, ethers.MaxUint256);
    await token.connect(bob).approve(stakingAddress, ethers.MaxUint256);

    return { token, staking, stakingAddress, owner, alice, bob, funder };
  }

  async function fundWith(funder: any, stakingAddress: string, amountEth: string) {
    return funder.sendTransaction({ to: stakingAddress, value: ethers.parseEther(amountEth) });
  }

  describe("stake / withdraw", function () {
    it("stakes the exact amount, tracked per-account and in totalStaked", async function () {
      const { staking, alice } = await loadFixture(deploy);
      await expect(staking.connect(alice).stake(ethers.parseEther("100")))
        .to.emit(staking, "Staked")
        .withArgs(alice.address, ethers.parseEther("100"));
      expect(await staking.staked(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("100"));
    });

    it("moves the actual ANCILLA tokens into the contract", async function () {
      const { token, staking, stakingAddress, alice } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      expect(await token.balanceOf(stakingAddress)).to.equal(ethers.parseEther("100"));
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("900"));
    });

    it("rejects staking zero", async function () {
      const { staking, alice } = await loadFixture(deploy);
      await expect(staking.connect(alice).stake(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    });

    it("rejects withdrawing more than staked", async function () {
      const { staking, alice } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("10"));
      await expect(staking.connect(alice).withdraw(ethers.parseEther("11"))).to.be.revertedWithCustomError(
        staking,
        "InsufficientStake"
      );
    });

    it("withdraw returns the exact tokens and drops totalStaked", async function () {
      const { token, staking, alice } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await expect(staking.connect(alice).withdraw(ethers.parseEther("40")))
        .to.emit(staking, "Withdrawn")
        .withArgs(alice.address, ethers.parseEther("40"));
      expect(await staking.staked(alice.address)).to.equal(ethers.parseEther("60"));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther("60"));
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("940"));
    });
  });

  describe("revenue distribution — the actual point of this contract", function () {
    it("reverts a plain ETH transfer if nobody is staked yet, instead of stranding it", async function () {
      const { staking, stakingAddress, funder } = await loadFixture(deploy);
      await expect(fundWith(funder, stakingAddress, "1")).to.be.revertedWithCustomError(staking, "NoStakersYet");
    });

    it("a single staker earns 100% of a plain ETH transfer (mirrors AncillaTreasuryMultisig's no-calldata send)", async function () {
      const { staking, stakingAddress, alice, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await expect(fundWith(funder, stakingAddress, "1"))
        .to.emit(staking, "RevenueDistributed")
        .withArgs(ethers.parseEther("1"), ethers.parseEther("100"));
      expect(await staking.earned(alice.address)).to.equal(ethers.parseEther("1"));
    });

    it("two unequal stakers split revenue exactly pro-rata to their stake at funding time", async function () {
      const { staking, stakingAddress, alice, bob, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("300")); // 75%
      await staking.connect(bob).stake(ethers.parseEther("100")); // 25%
      await fundWith(funder, stakingAddress, "4");
      expect(await staking.earned(alice.address)).to.equal(ethers.parseEther("3"));
      expect(await staking.earned(bob.address)).to.equal(ethers.parseEther("1"));
    });

    it("a staker who joins AFTER a distribution earns nothing from it — proves this isn't a flat airdrop", async function () {
      const { staking, stakingAddress, alice, bob, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fundWith(funder, stakingAddress, "1");
      await staking.connect(bob).stake(ethers.parseEther("100"));
      expect(await staking.earned(alice.address)).to.equal(ethers.parseEther("1"));
      expect(await staking.earned(bob.address)).to.equal(0);
    });

    it("claim() pays the exact accrued ETH and zeroes the balance, verified by real ETH delta not the return value", async function () {
      const { staking, stakingAddress, alice, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fundWith(funder, stakingAddress, "2");

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await staking.connect(alice).claim();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      expect(after - before + gasCost).to.equal(ethers.parseEther("2"));
      expect(await staking.earned(alice.address)).to.equal(0);
    });

    it("withdrawing partially does not forfeit already-accrued rewards", async function () {
      const { staking, stakingAddress, alice, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fundWith(funder, stakingAddress, "1");
      await staking.connect(alice).withdraw(ethers.parseEther("50"));
      expect(await staking.earned(alice.address)).to.equal(ethers.parseEther("1"));
    });

    it("a second, later distribution correctly accounts for a stake change in between", async function () {
      const { staking, stakingAddress, alice, bob, funder } = await loadFixture(deploy);
      await staking.connect(alice).stake(ethers.parseEther("100"));
      await fundWith(funder, stakingAddress, "1"); // alice alone: +1 ETH
      await staking.connect(bob).stake(ethers.parseEther("100")); // now 50/50
      await fundWith(funder, stakingAddress, "2"); // split: +1 each
      expect(await staking.earned(alice.address)).to.equal(ethers.parseEther("2"));
      expect(await staking.earned(bob.address)).to.equal(ethers.parseEther("1"));
    });
  });
});
