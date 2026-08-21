import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys AncillaTreasuryMultisig — the M-of-N multisig meant to replace a
 * single EOA as IntentCommitReveal's `_treasury` constructor argument on
 * any deployment that isn't purely disposable testnet scaffolding.
 *
 * This does NOT modify an already-deployed IntentCommitReveal — `treasury`
 * is `immutable`, so it can only be set at construction. Deploying this
 * multisig is step one; pointing a (re)deployment of IntentCommitReveal at
 * its address, via `deploy.ts`'s `treasury` variable, is step two, done
 * separately and deliberately, not automatically chained here.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-treasury.ts --network <network>
 *
 * Requires in .env:
 *   TREASURY_MULTISIG_OWNERS   comma-separated list of owner addresses,
 *                              e.g. 0xAaa...,0xBbb...,0xCcc...
 *                              Must be DISTINCT, non-zero addresses — the
 *                              contract itself rejects duplicates or
 *                              address(0), so a placeholder list reusing
 *                              the same key isn't just discouraged, it's
 *                              rejected outright.
 *   TREASURY_MULTISIG_THRESHOLD  how many of those owners must confirm a
 *                              withdrawal before it executes, e.g. 2
 *
 * There is deliberately no default owner list. A treasury multisig with a
 * silently-chosen owner set is worse than no multisig at all — it creates
 * false confidence. If these aren't set, the script stops and says so
 * instead of guessing.
 */
async function main() {
  const ownersRaw = process.env.TREASURY_MULTISIG_OWNERS;
  const thresholdRaw = process.env.TREASURY_MULTISIG_THRESHOLD;

  if (!ownersRaw) {
    throw new Error(
      "TREASURY_MULTISIG_OWNERS not set in .env — comma-separated list of " +
        "distinct owner addresses, e.g. TREASURY_MULTISIG_OWNERS=0xAaa...,0xBbb...,0xCcc..."
    );
  }
  if (!thresholdRaw) {
    throw new Error("TREASURY_MULTISIG_THRESHOLD not set in .env — e.g. TREASURY_MULTISIG_THRESHOLD=2");
  }

  const owners = ownersRaw.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
  const threshold = Number(thresholdRaw);

  for (const addr of owners) {
    if (!ethers.isAddress(addr)) {
      throw new Error(`TREASURY_MULTISIG_OWNERS contains something that isn't a valid address: "${addr}"`);
    }
  }
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error(`TREASURY_MULTISIG_THRESHOLD must be a positive integer, got "${thresholdRaw}"`);
  }
  if (threshold > owners.length) {
    throw new Error(
      `TREASURY_MULTISIG_THRESHOLD (${threshold}) is larger than the number of owners (${owners.length}) — impossible to ever reach.`
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying AncillaTreasuryMultisig with:", deployer.address);
  console.log("Owners:", owners);
  console.log("Threshold:", threshold, "of", owners.length);

  const Factory = await ethers.getContractFactory("AncillaTreasuryMultisig");
  const multisig = await Factory.deploy(owners, threshold);
  await multisig.waitForDeployment();

  const address = await multisig.getAddress();
  console.log("AncillaTreasuryMultisig deployed at:", address);

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
  existing.contracts.AncillaTreasuryMultisig = {
    address,
    owners,
    threshold,
  };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
  console.log(
    "\nThis address is NOT yet wired into IntentCommitReveal — that only " +
      "happens on IntentCommitReveal's next deployment, by setting its " +
      "`treasury` variable in deploy.ts to this address before running it."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
