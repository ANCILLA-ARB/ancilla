import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

describe("AncillaGovernor", function () {
  const CAP = ethers.parseEther("1000000");
  // AncillaToken overrides ERC20Votes'/Governor's clock to run on real
  // timestamps, not block numbers — see AncillaToken.sol's clock()
  // override for why (Arbitrum's in-contract block.number is the L1
  // block height, not the L2 count RPC tooling reports; timestamps don't
  // have that ambiguity). So these are SECONDS, not a block count.
  const VOTING_DELAY = 60; // seconds
  const VOTING_PERIOD = 600; // seconds — fast for testing, not a real value
  const PROPOSAL_THRESHOLD = 0;
  const QUORUM_NUMERATOR = 4; // 4% of total supply at proposal-creation time
  const TIMELOCK_MIN_DELAY = 3600; // seconds

  // For=1 in GovernorCountingSimple's VoteType enum
  const FOR = 1;
  const AGAINST = 0;

  async function deploy() {
    const [deployer, alice, bob, outsider, mintRecipient] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AncillaToken");
    const token = await Token.deploy(CAP, deployer.address);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();

    // Real, correct TimelockController setup: deployer starts with the
    // admin role purely to wire up roles, then renounces it — the same
    // "single EOA only during setup, then handed off" pattern used
    // throughout this repo (guardian/treasury EOA -> multisig).
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(TIMELOCK_MIN_DELAY, [], [], deployer.address);
    await timelock.waitForDeployment();
    const timelockAddress = await timelock.getAddress();

    const Governor = await ethers.getContractFactory("AncillaGovernor");
    const governor = await Governor.deploy(
      tokenAddress,
      timelockAddress,
      VOTING_DELAY,
      VOTING_PERIOD,
      PROPOSAL_THRESHOLD,
      QUORUM_NUMERATOR
    );
    await governor.waitForDeployment();
    const governorAddress = await governor.getAddress();

    const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
    const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
    const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
    const ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
    await (await timelock.connect(deployer).grantRole(PROPOSER_ROLE, governorAddress)).wait();
    await (await timelock.connect(deployer).grantRole(CANCELLER_ROLE, governorAddress)).wait();
    await (await timelock.connect(deployer).grantRole(EXECUTOR_ROLE, ethers.ZeroAddress)).wait(); // anyone may execute once queued+ready
    await (await timelock.connect(deployer).renounceRole(ADMIN_ROLE, deployer.address)).wait();

    // Voters need tokens AND self-delegation before a proposal's
    // snapshot block, or their balance doesn't count as voting power.
    // This must happen BEFORE ownership moves to the timelock below —
    // only the current owner can mint.
    await (await token.connect(deployer).mint(alice.address, ethers.parseEther("600"))).wait();
    await (await token.connect(deployer).mint(bob.address, ethers.parseEther("100"))).wait();
    await (await token.connect(alice).delegate(alice.address)).wait();
    await (await token.connect(bob).delegate(bob.address)).wait();

    // Hand token minting over to the DAO — from here on, mint() only
    // succeeds through a passed, queued, executed governance proposal.
    await (await token.connect(deployer).transferOwnership(timelockAddress)).wait();

    return { token, tokenAddress, timelock, timelockAddress, governor, governorAddress, deployer, alice, bob, outsider, mintRecipient, PROPOSER_ROLE, ADMIN_ROLE };
  }

  async function proposeMint(governor: any, token: any, tokenAddress: string, proposer: any, to: string, amount: bigint, salt = "") {
    const calldata = token.interface.encodeFunctionData("mint", [to, amount]);
    const description = `Mint ${amount} ANCILLA to ${to}${salt}`;
    const tx = await governor.connect(proposer).propose([tokenAddress], [0], [calldata], description);
    const receipt = await tx.wait();
    const event = receipt!.logs
      .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
      .find((e: any) => e && e.name === "ProposalCreated");
    const proposalId = event!.args.proposalId;
    const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(description));
    return { proposalId, calldata, descriptionHash };
  }

  describe("setup sanity", function () {
    it("hands minting off to the timelock — the deployer can no longer mint directly", async function () {
      const { token, deployer, mintRecipient, timelockAddress } = await loadFixture(deploy);
      expect(await token.owner()).to.equal(timelockAddress);
      await expect(token.connect(deployer).mint(mintRecipient.address, 1)).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount"
      );
    });

    it("the deployer no longer holds the timelock's admin role after setup", async function () {
      const { timelock, deployer, ADMIN_ROLE } = await loadFixture(deploy);
      expect(await timelock.hasRole(ADMIN_ROLE, deployer.address)).to.equal(false);
    });

    it("only the governor holds the proposer role", async function () {
      const { timelock, governorAddress, deployer, PROPOSER_ROLE } = await loadFixture(deploy);
      expect(await timelock.hasRole(PROPOSER_ROLE, governorAddress)).to.equal(true);
      expect(await timelock.hasRole(PROPOSER_ROLE, deployer.address)).to.equal(false);
    });
  });

  describe("full proposal lifecycle: propose -> vote -> queue -> execute", function () {
    it("a passed proposal actually mints tokens through the DAO, not around it", async function () {
      const { token, tokenAddress, governor, alice, bob, mintRecipient } = await loadFixture(deploy);
      const mintAmount = ethers.parseEther("500");

      const { proposalId, calldata, descriptionHash } = await proposeMint(
        governor, token, tokenAddress, alice, mintRecipient.address, mintAmount
      );
      expect(await governor.state(proposalId)).to.equal(0); // Pending

      await time.increase(VOTING_DELAY + 1);
      expect(await governor.state(proposalId)).to.equal(1); // Active

      // alice = 600 votes, bob = 100 votes, total supply 700 -> quorum
      // (4%) is 28 votes; alice alone clears it and outvotes any
      // opposition below.
      await governor.connect(alice).castVote(proposalId, FOR);
      await governor.connect(bob).castVote(proposalId, AGAINST);

      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(proposalId)).to.equal(4); // Succeeded

      await governor.queue([tokenAddress], [0], [calldata], descriptionHash);
      expect(await governor.state(proposalId)).to.equal(5); // Queued

      await time.increase(TIMELOCK_MIN_DELAY + 1);

      const before = await token.balanceOf(mintRecipient.address);
      await expect(governor.execute([tokenAddress], [0], [calldata], descriptionHash))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, mintRecipient.address, mintAmount);
      const after = await token.balanceOf(mintRecipient.address);

      expect(after - before).to.equal(mintAmount);
      expect(await governor.state(proposalId)).to.equal(7); // Executed
    });

    it("cannot execute before the timelock delay has elapsed, even after voting succeeds", async function () {
      const { token, tokenAddress, governor, alice, mintRecipient } = await loadFixture(deploy);
      const { proposalId, calldata, descriptionHash } = await proposeMint(
        governor, token, tokenAddress, alice, mintRecipient.address, ethers.parseEther("1"), " (early)"
      );
      await time.increase(VOTING_DELAY + 1);
      await governor.connect(alice).castVote(proposalId, FOR);
      await time.increase(VOTING_PERIOD + 1);
      await governor.queue([tokenAddress], [0], [calldata], descriptionHash);

      // No time.increase here — the timelock's minDelay has not passed.
      await expect(governor.execute([tokenAddress], [0], [calldata], descriptionHash)).to.be.reverted;
    });

    it("a proposal that fails to reach quorum is Defeated, and can never be queued", async function () {
      const { token, tokenAddress, governor, bob, mintRecipient } = await loadFixture(deploy);
      // bob alone has 100 of 700 total supply — comfortably above the 4%
      // quorum by weight, so vote AGAINST instead to test the "quorum
      // reached but didn't succeed" path distinctly from "no quorum".
      const { proposalId, calldata, descriptionHash } = await proposeMint(
        governor, token, tokenAddress, bob, mintRecipient.address, ethers.parseEther("1"), " (rejected)"
      );
      await time.increase(VOTING_DELAY + 1);
      await governor.connect(bob).castVote(proposalId, AGAINST);
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(proposalId)).to.equal(3); // Defeated

      await expect(governor.queue([tokenAddress], [0], [calldata], descriptionHash)).to.be.reverted;
    });

    it("an outsider with no delegated voting power cannot pass a proposal alone", async function () {
      const { token, tokenAddress, governor, outsider, mintRecipient } = await loadFixture(deploy);
      // outsider was never minted any ANCILLA, so proposalThreshold=0
      // still lets them PROPOSE, but they have zero votes to cast.
      const { proposalId } = await proposeMint(
        governor, token, tokenAddress, outsider, mintRecipient.address, ethers.parseEther("1"), " (outsider)"
      );
      await time.increase(VOTING_DELAY + 1);
      await expect(governor.connect(outsider).castVote(proposalId, FOR)).to.not.be.reverted; // casting 0 votes is allowed, just meaningless
      await time.increase(VOTING_PERIOD + 1);
      expect(await governor.state(proposalId)).to.equal(3); // Defeated — no quorum reached
    });
  });
});
