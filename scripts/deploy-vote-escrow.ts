import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { loadTokenStackDeployment } from "./lib/deployments";

/**
 * Deploys AncillaVoteEscrow — a lock-weighted revenue-share pool,
 * additive to the token/governance stack deployed by
 * scripts/deploy-token.ts, not a replacement for AncillaStaking. Reuses
 * the already-deployed AncillaToken; doesn't touch or redeploy anything
 * else in the stack.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-vote-escrow.ts --network arbitrumSepolia
 *
 * Requires deployments/<network>.json to already have the token stack
 * (scripts/deploy-token.ts) populated.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const stack = loadTokenStackDeployment(network.name);
  console.log("Deploying with:", deployer.address);
  console.log("AncillaToken:", stack.token);

  const Escrow = await ethers.getContractFactory("AncillaVoteEscrow");
  const escrow = await Escrow.deploy(stack.token);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("AncillaVoteEscrow:", escrowAddress);

  const minLock = await escrow.MIN_LOCK();
  const maxLock = await escrow.MAX_LOCK();

  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const existing = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  existing.contracts.AncillaVoteEscrow = {
    address: escrowAddress,
    stakingToken: stack.token,
    minLockSeconds: Number(minLock),
    maxLockSeconds: Number(maxLock),
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
