import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys AncillaGuardianMultisig — the M-of-N multisig meant to replace a
 * single EOA as IntentCommitReveal's (and AncillaSwapHook's) `_guardian`
 * constructor argument on any deployment that isn't purely disposable
 * testnet scaffolding. Same reasoning as scripts/deploy-treasury.ts: this
 * does NOT modify an already-deployed target — `guardian` is `immutable`
 * on every contract that has one, so it can only be set at construction.
 * Deploying this multisig is step one; pointing a (re)deployment of
 * IntentCommitReveal/AncillaSwapHook at its address is step two, done
 * separately.
 *
 * Unlike the treasury multisig, this one is NOT bound to a specific target
 * at construction — see AncillaGuardianMultisig.sol's header comment for
 * why (circular deploy dependency) and why that's safe (only pause()/
 * unpause() are ever callable, target is chosen per-proposal, never
 * arbitrary calldata). One deployed instance can therefore guard every
 * Ancilla contract that points `guardian` at it.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-guardian.ts --network <network>
 *
 * Requires in .env:
 *   GUARDIAN_MULTISIG_OWNERS     comma-separated list of owner addresses
 *   GUARDIAN_MULTISIG_THRESHOLD  how many must confirm before pause/unpause executes
 *
 * There is deliberately no default owner list — same "a silently-chosen
 * owner set is worse than none" reasoning as the treasury multisig.
 */
async function main() {
  const ownersRaw = process.env.GUARDIAN_MULTISIG_OWNERS;
  const thresholdRaw = process.env.GUARDIAN_MULTISIG_THRESHOLD;

  if (!ownersRaw) {
    throw new Error(
      "GUARDIAN_MULTISIG_OWNERS not set in .env — comma-separated list of " +
        "distinct owner addresses, e.g. GUARDIAN_MULTISIG_OWNERS=0xAaa...,0xBbb...,0xCcc..."
    );
  }
  if (!thresholdRaw) {
    throw new Error("GUARDIAN_MULTISIG_THRESHOLD not set in .env — e.g. GUARDIAN_MULTISIG_THRESHOLD=2");
  }

  const owners = ownersRaw.split(",").map((a) => a.trim()).filter((a) => a.length > 0);
  const threshold = Number(thresholdRaw);

  for (const addr of owners) {
    if (!ethers.isAddress(addr)) {
      throw new Error(`GUARDIAN_MULTISIG_OWNERS contains something that isn't a valid address: "${addr}"`);
    }
  }
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error(`GUARDIAN_MULTISIG_THRESHOLD must be a positive integer, got "${thresholdRaw}"`);
  }
  if (threshold > owners.length) {
    throw new Error(
      `GUARDIAN_MULTISIG_THRESHOLD (${threshold}) is larger than the number of owners (${owners.length}) — impossible to ever reach.`
    );
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deploying AncillaGuardianMultisig with:", deployer.address);
  console.log("Owners:", owners);
  console.log("Threshold:", threshold, "of", owners.length);

  const Factory = await ethers.getContractFactory("AncillaGuardianMultisig");
  const multisig = await Factory.deploy(owners, threshold);
  await multisig.waitForDeployment();

  const address = await multisig.getAddress();
  console.log("AncillaGuardianMultisig deployed at:", address);

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
  existing.contracts.AncillaGuardianMultisig = {
    address,
    owners,
    threshold,
  };
  fs.mkdirSync(path.dirname(deploymentsPath), { recursive: true });
  fs.writeFileSync(deploymentsPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("Written to:", deploymentsPath);
  console.log(
    "\nThis address is NOT yet wired into any target contract — that only " +
      "happens on that contract's next deployment, by setting its " +
      "`guardian` variable to this address before running its deploy script."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
