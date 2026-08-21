import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys IntentCommitReveal to whatever network Hardhat is pointed at, and
 * writes the result to deployments/<network>.json — the single source of
 * truth scripts/demo*.ts read the live contract address from, instead of
 * each hardcoding its own copy (which is exactly how three separate demo
 * scripts ended up pointing at three different, two of them stale,
 * deployments — caught during a repo cleanup pass, not before).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and ARBITRUM_SEPOLIA_RPC set in .env (see .env.example).
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // Tunable batching/economic parameters — see README for how these were chosen.
  // Timing is in SECONDS via block.timestamp, not block count — Arbitrum's
  // in-contract `block.number` tracks the L1 block height, not the L2 block
  // height RPC tooling reports, so block-count windows don't line up with
  // wall-clock time the way you'd expect. See the contract's header comment.
  const COMMIT_WINDOW_SECONDS = 120; // ~epoch length agents commit into
  const REVEAL_DELAY_SECONDS = 30; // buffer before reveal opens for the whole epoch
  const REVEAL_WINDOW_SECONDS = 120; // how long the shared reveal window stays open
  // Kept deliberately small: sized to what a public testnet faucet actually
  // hands out (often as little as 0.005 ETH), so the bond + gas for a full
  // commit-reveal-execute demo cycle comfortably fits. NOT a production value.
  const MIN_BOND = ethers.parseEther("0.001");
  const treasury = deployer.address; // replace with a real multisig before any real deployment

  const Factory = await ethers.getContractFactory("IntentCommitReveal");
  const contract = await Factory.deploy(
    COMMIT_WINDOW_SECONDS,
    REVEAL_DELAY_SECONDS,
    REVEAL_WINDOW_SECONDS,
    MIN_BOND,
    treasury
  );
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log("IntentCommitReveal deployed at:", contractAddress);
  console.log({
    COMMIT_WINDOW_SECONDS,
    REVEAL_DELAY_SECONDS,
    REVEAL_WINDOW_SECONDS,
    MIN_BOND: MIN_BOND.toString(),
    treasury,
  });

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
  existing.contracts.IntentCommitReveal = {
    address: contractAddress,
    commitWindowSeconds: COMMIT_WINDOW_SECONDS,
    revealDelaySeconds: REVEAL_DELAY_SECONDS,
    revealWindowSeconds: REVEAL_WINDOW_SECONDS,
    minBond: MIN_BOND.toString(),
    treasury,
  };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
