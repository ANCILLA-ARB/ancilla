import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Deploys IntentCommitReveal + a MockExecutor to whatever local node this
 *  is pointed at, and writes their addresses to relay-server/local-deployment.json
 *  so other scripts (the relay server, the E2E client) can read them without
 *  hardcoding addresses that change every time this runs. */
async function main() {
  const [deployer] = await ethers.getSigners();

  const COMMIT_WINDOW_SECONDS = 30;
  const REVEAL_DELAY_SECONDS = 5;
  const REVEAL_WINDOW_SECONDS = 30;
  const MIN_BOND = ethers.parseEther("0.01");

  const Factory = await ethers.getContractFactory("IntentCommitReveal");
  const contract = await Factory.deploy(
    COMMIT_WINDOW_SECONDS,
    REVEAL_DELAY_SECONDS,
    REVEAL_WINDOW_SECONDS,
    MIN_BOND,
    deployer.address
  );
  await contract.waitForDeployment();

  const ExecutorFactory = await ethers.getContractFactory("MockExecutor");
  const executor = await ExecutorFactory.deploy();
  await executor.waitForDeployment();

  const out = {
    contractAddress: await contract.getAddress(),
    executorAddress: await executor.getAddress(),
    deployer: deployer.address,
    commitWindowSeconds: COMMIT_WINDOW_SECONDS,
    revealDelaySeconds: REVEAL_DELAY_SECONDS,
    revealWindowSeconds: REVEAL_WINDOW_SECONDS,
    minBond: MIN_BOND.toString(),
  };

  const outPath = path.join(__dirname, "..", "relay-server", "local-deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Deployed to local node:", out);
  console.log("Written to:", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
