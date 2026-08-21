import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment } from "./lib/deployments";

/**
 * Live proof, on Arbitrum Sepolia, that the bond-locking fix actually works
 * outside the local test sandbox: commit an intent, then immediately try to
 * withdraw the full bond — this must now be REJECTED, where an earlier
 * version of this contract allowed it (see README "Bugs we hit and fixed").
 *
 * Usage:
 *   npx hardhat run scripts/demo-bond-lock.ts --network arbitrumSepolia
 */

const INTENT_CONTRACT_ADDRESS = loadIntentCommitRevealDeployment("arbitrumSepolia").address;

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}

async function main() {
  // Uses AGENT_PRIVATE_KEY specifically (rather than the default PRIVATE_KEY
  // signer) simply because that wallet has a higher remaining testnet
  // balance at the time this script was written — no other significance;
  // this test only involves a single actor.
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  const signer = agentPk ? new ethers.Wallet(agentPk, ethers.provider) : (await ethers.getSigners())[0];
  console.log("== Ancilla live bond-lock verification: Arbitrum Sepolia ==");
  console.log("Signer:", signer.address);

  const contract = await ethers.getContractAt("IntentCommitReveal", INTENT_CONTRACT_ADDRESS, signer);
  const minBond: bigint = await contract.minBond();

  console.log("\n[1/4] Ensuring bond covers at least one commitment...");
  let bond: bigint = await contract.bondBalance(signer.address);
  if (bond < minBond) {
    const tx = await contract.depositBond({ value: minBond - bond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
    bond = await contract.bondBalance(signer.address);
  }
  console.log("   bondBalance:", ethers.formatEther(bond), "ETH");

  console.log("\n[2/4] Committing an intent...");
  const nonce = Date.now();
  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [`bond-lock-check:${nonce}`]);
  const built = buildIntent(signer.address, intentData, nonce);
  const commitTx = await contract.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();

  const locked: bigint = await contract.lockedBond(signer.address);
  console.log("   lockedBond after commit:", ethers.formatEther(locked), "ETH (expected >=", ethers.formatEther(minBond), ")");

  console.log("\n[3/4] Attempting to withdraw the full bond RIGHT NOW (must fail)...");
  let withdrawalBlocked = false;
  try {
    const tx = await contract.withdrawBond(bond);
    await tx.wait();
    console.log("   ❌ withdrawBond unexpectedly SUCCEEDED:", explorerTx(tx.hash));
  } catch (err: any) {
    withdrawalBlocked = true;
    const reason = err?.shortMessage || err?.message || String(err);
    console.log("   ✅ withdrawBond correctly reverted. Reason surfaced by node:", reason);
  }

  console.log("\n[4/4] Independently re-reading on-chain state to confirm nothing changed...");
  const bondAfter: bigint = await contract.bondBalance(signer.address);
  const lockedAfter: bigint = await contract.lockedBond(signer.address);
  console.log("   bondBalance unchanged:", bondAfter === bond ? "✓" : "✗ MISMATCH", ethers.formatEther(bondAfter), "ETH");
  console.log("   lockedBond unchanged: ", lockedAfter === locked ? "✓" : "✗ MISMATCH", ethers.formatEther(lockedAfter), "ETH");

  const success = withdrawalBlocked && bondAfter === bond && lockedAfter === locked;
  console.log(
    success
      ? "\n✅ BOND-LOCK FIX VERIFIED LIVE — withdrawal against a pending commitment is blocked on real Arbitrum Sepolia, not just in local tests."
      : "\n❌ VERIFICATION FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
