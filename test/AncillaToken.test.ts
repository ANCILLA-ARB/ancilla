import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("AncillaToken", function () {
  const CAP = ethers.parseEther("1000000"); // 1,000,000 ANCILLA — testnet-sized, not tokenomics

  async function deploy() {
    const [owner, alice, bob] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AncillaToken");
    const token = await Token.deploy(CAP, owner.address);
    await token.waitForDeployment();
    return { token, owner, alice, bob };
  }

  describe("constructor", function () {
    it("sets name, symbol, cap, and owner", async function () {
      const { token, owner } = await loadFixture(deploy);
      expect(await token.name()).to.equal("Ancilla");
      expect(await token.symbol()).to.equal("ANCILLA");
      expect(await token.cap()).to.equal(CAP);
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.totalSupply()).to.equal(0);
    });
  });

  describe("mint", function () {
    it("lets the owner mint up to the cap", async function () {
      const { token, owner, alice } = await loadFixture(deploy);
      await expect(token.connect(owner).mint(alice.address, CAP))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, alice.address, CAP);
      expect(await token.balanceOf(alice.address)).to.equal(CAP);
    });

    it("rejects minting past the cap", async function () {
      const { token, owner, alice } = await loadFixture(deploy);
      await expect(token.connect(owner).mint(alice.address, CAP + 1n)).to.be.revertedWithCustomError(
        token,
        "ERC20ExceededCap"
      );
    });

    it("rejects a non-owner minting", async function () {
      const { token, alice, bob } = await loadFixture(deploy);
      await expect(token.connect(alice).mint(bob.address, 1)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("ERC20Votes — voting power tracks delegation, not just balance", function () {
    it("a fresh holder has zero voting power until they delegate (to themselves or anyone)", async function () {
      const { token, owner, alice } = await loadFixture(deploy);
      await token.connect(owner).mint(alice.address, ethers.parseEther("100"));
      // Balance is nonzero, but votes are zero — ERC20Votes requires an
      // explicit delegation before a balance counts as voting power. This
      // is the actual behavior AncillaGovernor's quorum/proposal checks
      // depend on, not an incidental detail.
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await token.getVotes(alice.address)).to.equal(0);
    });

    it("self-delegation makes the full balance count as voting power", async function () {
      const { token, owner, alice } = await loadFixture(deploy);
      await token.connect(owner).mint(alice.address, ethers.parseEther("100"));
      await token.connect(alice).delegate(alice.address);
      expect(await token.getVotes(alice.address)).to.equal(ethers.parseEther("100"));
    });

    it("delegating to someone else moves the voting power, not the tokens", async function () {
      const { token, owner, alice, bob } = await loadFixture(deploy);
      await token.connect(owner).mint(alice.address, ethers.parseEther("100"));
      await token.connect(alice).delegate(bob.address);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("100"));
      expect(await token.getVotes(alice.address)).to.equal(0);
      expect(await token.getVotes(bob.address)).to.equal(ethers.parseEther("100"));
    });

    it("transferring tokens after delegation moves voting power with them", async function () {
      const { token, owner, alice, bob } = await loadFixture(deploy);
      await token.connect(owner).mint(alice.address, ethers.parseEther("100"));
      await token.connect(alice).delegate(alice.address);
      await token.connect(alice).transfer(bob.address, ethers.parseEther("40"));
      expect(await token.getVotes(alice.address)).to.equal(ethers.parseEther("60"));
      // bob never delegated, so the 40 he received doesn't count yet.
      expect(await token.getVotes(bob.address)).to.equal(0);
    });
  });

  describe("ERC20Permit", function () {
    it("exposes EIP-2612 domain separator and nonces (gasless-approval plumbing)", async function () {
      const { token, alice } = await loadFixture(deploy);
      expect(await token.nonces(alice.address)).to.equal(0);
      expect(await token.DOMAIN_SEPARATOR()).to.match(/^0x[0-9a-fA-F]{64}$/);
    });
  });
});
