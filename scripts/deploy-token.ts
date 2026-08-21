import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the ANCILLA governance/utility token stack: AncillaToken
 * (ERC20Votes + ERC20Permit + ERC20Capped), a plain OpenZeppelin
 * TimelockController, AncillaGovernor (wired to both), and AncillaStaking
 * (revenue-share, funded by AncillaTreasuryMultisig's existing
 * withdrawal flow — no changes to that contract were needed).
 *
 * Deliberately does NOT:
 *   - Mint any initial supply. Allocation/tokenomics is an explicit,
 *     separate decision (see README) — this script only builds the
 *     machinery, it doesn't decide who gets how much.
 *   - Transfer AncillaToken's owner role to the timelock. The deployer
 *     stays as owner after this script runs, specifically so a
 *     follow-up step (minting an initial distribution, or a demo like
 *     scripts/demo-governor.ts) can still call mint() directly before
 *     minting is permanently handed to governance. Call
 *     `token.transferOwnership(timelockAddress)` yourself once initial
 *     minting is actually done — it's a one-way door, so it isn't taken
 *     here automatically.
 *
 * DOES fully wire the timelock's roles correctly and irreversibly in
 * this pass, because there's no reason to leave that half-done: the
 * governor gets PROPOSER_ROLE and CANCELLER_ROLE, EXECUTOR_ROLE is
 * granted to the zero address (meaning anyone may execute a queued,
 * ready proposal — a common, safe pattern, since by the time something
 * is queued it already passed a vote), and the deployer's own
 * DEFAULT_ADMIN_ROLE is renounced at the end of this script — so no
 * single EOA retains override power over the timelock once this
 * finishes.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-token.ts --network arbitrumSepolia
 *
 * Voting delay/period, proposal threshold, quorum, cap, and timelock
 * delay below are all testnet-sized for fast demoing — same "not tuned
 * for a real deployment" caveat as IntentCommitReveal's MIN_BOND. Real
 * tokenomics (supply, allocation, real governance timing) is explicitly
 * left for later, not decided here.
 */
const TOKEN_CAP = ethers.parseEther("1000000000"); // 1,000,000,000 ANCILLA hard cap — a round number, NOT a tokenomics decision
const TIMELOCK_MIN_DELAY = 120; // seconds — fast for testnet demoing; a real deployment needs a delay actually long enough to react to a malicious proposal
// AncillaToken overrides its voting clock to run on real timestamps, not
// block numbers — see AncillaToken.sol's clock() override. On Arbitrum,
// the block.number a contract sees is the L1 Ethereum block height, not
// the L2 block count RPC tooling reports, so a block-based voting
// delay/period would be checked against a completely different scale
// than intended. These are SECONDS, not a block count.
const VOTING_DELAY = 60; // seconds
const VOTING_PERIOD = 300; // seconds — short on purpose, see demo-governor.ts
const PROPOSAL_THRESHOLD = 0; // anyone holding any delegated votes may propose, for demo purposes
const QUORUM_NUMERATOR = 4; // 4% of total supply at proposal-creation time

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  console.log("\n[1/4] AncillaToken...");
  const Token = await ethers.getContractFactory("AncillaToken");
  const token = await Token.deploy(TOKEN_CAP, deployer.address);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("   AncillaToken:", tokenAddress);

  console.log("\n[2/4] TimelockController...");
  const Timelock = await ethers.getContractFactory("TimelockController");
  const timelock = await Timelock.deploy(TIMELOCK_MIN_DELAY, [], [], deployer.address);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();
  console.log("   TimelockController:", timelockAddress);

  console.log("\n[3/4] AncillaGovernor...");
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
  console.log("   AncillaGovernor:", governorAddress);

  console.log("   Wiring timelock roles...");
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE();
  const CANCELLER_ROLE = await timelock.CANCELLER_ROLE();
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE();
  const ADMIN_ROLE = await timelock.DEFAULT_ADMIN_ROLE();
  await (await timelock.grantRole(PROPOSER_ROLE, governorAddress)).wait();
  await (await timelock.grantRole(CANCELLER_ROLE, governorAddress)).wait();
  await (await timelock.grantRole(EXECUTOR_ROLE, ethers.ZeroAddress)).wait();
  await (await timelock.renounceRole(ADMIN_ROLE, deployer.address)).wait();
  console.log("   Deployer's timelock admin role renounced — governance now self-governs.");

  console.log("\n[4/4] AncillaStaking...");
  const Staking = await ethers.getContractFactory("AncillaStaking");
  const staking = await Staking.deploy(tokenAddress);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log("   AncillaStaking:", stakingAddress);

  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  let existing: any = { network: network.name, contracts: {} };
  if (fs.existsSync(deploymentsPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
    } catch {
      // corrupt or unreadable — start fresh rather than crash the deploy
    }
  }
  existing.network = network.name;
  existing.chainId = Number((await ethers.provider.getNetwork()).chainId);
  existing.contracts = existing.contracts || {};
  existing.contracts.AncillaToken = { address: tokenAddress, cap: TOKEN_CAP.toString(), owner: deployer.address };
  existing.contracts.AncillaTimelock = { address: timelockAddress, minDelaySeconds: TIMELOCK_MIN_DELAY };
  existing.contracts.AncillaGovernor = {
    address: governorAddress,
    votingDelaySeconds: VOTING_DELAY,
    votingPeriodSeconds: VOTING_PERIOD,
    proposalThreshold: PROPOSAL_THRESHOLD,
    quorumNumerator: QUORUM_NUMERATOR,
  };
  existing.contracts.AncillaStaking = { address: stakingAddress, stakingToken: tokenAddress };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("\nWritten to:", deploymentsPath);
  console.log(
    "\nNOTE: AncillaToken.owner() is still the deployer — mint an initial " +
      "distribution yourself, then call token.transferOwnership(timelockAddress) " +
      "when you're ready to hand minting to the DAO permanently. Nothing was " +
      "minted or transferred automatically."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
