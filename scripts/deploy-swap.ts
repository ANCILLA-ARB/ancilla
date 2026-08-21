import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the real (non-mock) IIntentExecutor stack — two test tokens,
 * AncillaSwapPool, and SwapExecutor — to whatever network Hardhat is
 * pointed at, and records the result in deployments/<network>.json
 * alongside the IntentCommitReveal entry scripts/deploy.ts already writes
 * there (same single-source-of-truth file, not a separate one).
 *
 * Usage:
 *   npx hardhat run scripts/deploy-swap.ts --network arbitrumSepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const Token = await ethers.getContractFactory("TestToken");
  const tokenA = await Token.deploy("Ancilla Test USD", "aUSD");
  await tokenA.waitForDeployment();
  const tokenAAddress = await tokenA.getAddress();
  console.log("TestToken aUSD deployed at:", tokenAAddress);

  const tokenB = await Token.deploy("Ancilla Test ETH", "aETH");
  await tokenB.waitForDeployment();
  const tokenBAddress = await tokenB.getAddress();
  console.log("TestToken aETH deployed at:", tokenBAddress);

  const Pool = await ethers.getContractFactory("AncillaSwapPool");
  const pool = await Pool.deploy(tokenAAddress, tokenBAddress);
  await pool.waitForDeployment();
  const poolAddress = await pool.getAddress();
  console.log("AncillaSwapPool deployed at:", poolAddress);

  const Executor = await ethers.getContractFactory("SwapExecutor");
  const executor = await Executor.deploy(poolAddress);
  await executor.waitForDeployment();
  const executorAddress = await executor.getAddress();
  console.log("SwapExecutor deployed at:", executorAddress);

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
  existing.contracts.TestTokenA = { address: tokenAAddress, name: "Ancilla Test USD", symbol: "aUSD" };
  existing.contracts.TestTokenB = { address: tokenBAddress, name: "Ancilla Test ETH", symbol: "aETH" };
  existing.contracts.AncillaSwapPool = { address: poolAddress, tokenA: tokenAAddress, tokenB: tokenBAddress };
  existing.contracts.SwapExecutor = { address: executorAddress, pool: poolAddress };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
