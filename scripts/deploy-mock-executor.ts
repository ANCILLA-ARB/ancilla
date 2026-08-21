import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys a throwaway MockExecutor to whatever network Hardhat is pointed
 * at, purely so live relay-server proofs (scripts/relay-server-live-e2e.ts)
 * have a real, harmless IIntentExecutor to point revealIntentViaRelay at —
 * the point of that test is proving the RELAY mechanism works over HTTP,
 * not exercising a real swap (scripts/demo-swap.ts / demo-hook-swap.ts
 * already do that separately). Written to deployments/<network>.json under
 * its own key so it doesn't collide with anything else.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-mock-executor.ts --network arbitrumSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("MockExecutor");
  const executor = await Factory.deploy();
  await executor.waitForDeployment();
  const address = await executor.getAddress();
  console.log("MockExecutor deployed at:", address, "by", deployer.address);

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
  existing.contracts.MockExecutor = { address };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
