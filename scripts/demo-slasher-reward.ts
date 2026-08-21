import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * Live proof for the slasher-reward economic hardening: commits an intent
 * from one wallet, lets it go unrevealed past the reveal window, then calls
 * slashNoReveal from a SECOND, unrelated wallet — proving that wallet earns
 * a real reward (gas-cost-adjusted) for doing so, instead of the entire
 * penalty disappearing into the treasury with nothing in it for whoever
 * bothered to enforce the rule.
 *
 * Usage:
 *   npx hardhat run scripts/demo-slasher-reward.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY (plays the "agent who ghosts" role) and
 * AGENT_PRIVATE_KEY (plays the "slasher" role — an unrelated, disinterested
 * third party) in .env.
 */

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function waitForTimestamp(target: bigint, label: string) {
  process.stdout.write(`   waiting for timestamp ${target} (${label})`);
  for (;;) {
    const latest = await ethers.provider.getBlock("latest");
    const current = BigInt(latest!.timestamp);
    if (current >= target) {
      console.log(` — reached (current: ${current})`);
      return;
    }
    const remaining = target - current;
    process.stdout.write(` [${remaining}s left]`);
    await new Promise((r) => setTimeout(r, Math.min(15000, Number(remaining) * 1000 + 1000)));
  }
}

async function main() {
  const slasherPk = process.env.AGENT_PRIVATE_KEY;
  if (!slasherPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const deployment = loadIntentCommitRevealDeployment("arbitrumSepolia");
  const [ghostingAgent] = await ethers.getSigners();
  const slasher = new ethers.Wallet(slasherPk, ethers.provider);

  console.log("== Ancilla slasher-reward live demo: Arbitrum Sepolia ==");
  console.log("IntentCommitReveal:", deployment.address, explorerAddr(deployment.address));
  console.log("Agent (will ghost, never reveal):", ghostingAgent.address);
  console.log("Slasher (unrelated third party):", slasher.address);
  console.log("slasherRewardBps:", deployment.slasherRewardBps, "(", Number(deployment.slasherRewardBps) / 100, "%)");

  const contract = await ethers.getContractAt("IntentCommitReveal", deployment.address, ghostingAgent);

  // ---------------------------------------------------------------------
  console.log("\n[1/5] Agent bonds and commits, with no intention of ever revealing...");
  const minBond = BigInt(deployment.minBond);
  const lockedBond: bigint = await contract.lockedBond(ghostingAgent.address);
  const currentBond: bigint = await contract.bondBalance(ghostingAgent.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await contract.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["intent that will never be revealed"]);
  const built = buildIntent(ghostingAgent.address, intentData, Date.now());
  const commitTx = await contract.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();

  const commitment = await contract.commitments(built.commitId);
  const closeTime = await contract.revealCloseTimeOf(commitment.epoch);

  // ---------------------------------------------------------------------
  console.log("\n[2/5] Waiting for the reveal window to close, unrevealed...");
  await waitForTimestamp(closeTime, "reveal window closes");

  // ---------------------------------------------------------------------
  console.log("\n[3/5] Reading balances before the slash...");
  const treasuryBalBefore = await ethers.provider.getBalance(deployment.treasury);
  const slasherBalBefore = await ethers.provider.getBalance(slasher.address);

  // ---------------------------------------------------------------------
  console.log("\n[4/5] Slasher (unrelated wallet) calls slashNoReveal...");
  const contractAsSlasher = contract.connect(slasher);
  const slashTx = await contractAsSlasher.slashNoReveal(built.commitId);
  console.log("   slashNoReveal tx:", explorerTx(slashTx.hash));
  const slashReceipt = await slashTx.wait();
  const gasCost = slashReceipt!.gasUsed * slashReceipt!.gasPrice;

  // ---------------------------------------------------------------------
  console.log("\n[5/5] Independently verifying the reward split, on-chain...");
  const treasuryBalAfter = await ethers.provider.getBalance(deployment.treasury);
  const slasherBalAfter = await ethers.provider.getBalance(slasher.address);

  const toTreasury = treasuryBalAfter - treasuryBalBefore;
  const netToSlasher = slasherBalAfter - slasherBalBefore + gasCost; // add back its own gas

  const expectedReward = (minBond * BigInt(deployment.slasherRewardBps ?? 0)) / 10_000n;
  const expectedToTreasury = minBond - expectedReward;

  console.log("   treasury received:", ethers.formatEther(toTreasury), "ETH (expected", ethers.formatEther(expectedToTreasury), ")");
  console.log("   slasher net reward:", ethers.formatEther(netToSlasher), "ETH (expected", ethers.formatEther(expectedReward), ")");

  const resolved = await contract.commitments(built.commitId);
  const slashedEvents = await contract.queryFilter(
    contract.filters.IntentSlashed(),
    slashReceipt!.blockNumber,
    slashReceipt!.blockNumber
  );

  console.log("   commitments(commitId).slashed =", resolved.slashed);
  console.log("   IntentSlashed events found:", slashedEvents.length);

  const success =
    resolved.slashed === true &&
    toTreasury === expectedToTreasury &&
    netToSlasher === expectedReward &&
    slashedEvents.length === 1;

  console.log(
    success
      ? "\n✅ SLASHER REWARD DEMO PASSED — an unrelated third party earned a real reward for enforcing a ghosted commitment's penalty, live on Arbitrum Sepolia, verified independently on-chain."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
