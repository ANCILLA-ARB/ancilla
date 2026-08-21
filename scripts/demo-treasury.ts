import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Live proof for AncillaTreasuryMultisig on Arbitrum Sepolia: funds it,
 * proposes a small withdrawal, gets it confirmed by a second owner, then
 * executes it — verifying independently afterward that the exact amount
 * moved and that a single owner alone could not have done any of the
 * fund-moving steps.
 *
 * Usage:
 *   npx hardhat run scripts/demo-treasury.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env — both must be listed
 * as owners of the deployed multisig (deploy-treasury.ts's
 * TREASURY_MULTISIG_OWNERS). Uses deployments/<network>.json's
 * AncillaTreasuryMultisig entry, written by deploy-treasury.ts.
 */
function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function main() {
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const deploymentsPath = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const data = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const entry = data?.contracts?.AncillaTreasuryMultisig;
  if (!entry?.address) {
    throw new Error("No AncillaTreasuryMultisig in deployments file — run scripts/deploy-treasury.ts first");
  }

  const [ownerA] = await ethers.getSigners(); // from PRIVATE_KEY
  const ownerB = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla treasury multisig live demo: Arbitrum Sepolia ==");
  console.log("Multisig:", entry.address, explorerAddr(entry.address));
  console.log("Owner A (proposer):", ownerA.address);
  console.log("Owner B (co-confirmer):", ownerB.address);
  console.log("Threshold:", entry.threshold, "of", entry.owners.length);

  const multisig = await ethers.getContractAt("AncillaTreasuryMultisig", entry.address, ownerA);
  const isAOwner: boolean = await multisig.isOwner(ownerA.address);
  const isBOwner: boolean = await multisig.isOwner(ownerB.address);
  if (!isAOwner || !isBOwner) {
    throw new Error(
      `PRIVATE_KEY/AGENT_PRIVATE_KEY must both be owners of this multisig. isOwner(A)=${isAOwner} isOwner(B)=${isBOwner}`
    );
  }

  // ---------------------------------------------------------------------
  console.log("\n[1/5] Funding the multisig with a small amount of test ETH...");
  const fundAmount = ethers.parseEther("0.0006");
  const balBefore: bigint = await ethers.provider.getBalance(entry.address);
  const fundTx = await ownerA.sendTransaction({ to: entry.address, value: fundAmount });
  console.log("   tx:", explorerTx(fundTx.hash));
  await fundTx.wait();
  const balAfterFund: bigint = await ethers.provider.getBalance(entry.address);
  console.log("   multisig balance:", ethers.formatEther(balAfterFund), "ETH");

  // ---------------------------------------------------------------------
  console.log("\n[2/5] Owner A proposes withdrawing part of it back to Owner A...");
  const withdrawAmount = ethers.parseEther("0.0002");
  const proposeTx = await multisig.proposeWithdrawal(ownerA.address, withdrawAmount);
  console.log("   proposeWithdrawal tx:", explorerTx(proposeTx.hash));
  const proposeReceipt = await proposeTx.wait();
  const id: bigint = (await multisig.withdrawalCount()) - 1n;
  console.log("   withdrawal id:", id.toString(), "(auto-confirmed by the proposer, 1 of", entry.threshold, "needed)");

  // ---------------------------------------------------------------------
  console.log("\n[3/5] Attempting to execute with only 1 confirmation (must fail)...");
  let rejectedEarly = false;
  try {
    await multisig.executeWithdrawal.staticCall(id);
  } catch (err: any) {
    rejectedEarly = true;
    console.log("   correctly rejected:", err.shortMessage || err.message);
  }
  if (!rejectedEarly) {
    throw new Error("executeWithdrawal should have been rejected with only 1/2 confirmations, but wasn't");
  }

  // ---------------------------------------------------------------------
  console.log("\n[4/5] Owner B confirms — now at threshold — then Owner A executes...");
  const multisigAsB = multisig.connect(ownerB);
  const confirmTx = await multisigAsB.confirmWithdrawal(id);
  console.log("   confirmWithdrawal tx:", explorerTx(confirmTx.hash));
  await confirmTx.wait();

  const ownerABalBeforeExec: bigint = await ethers.provider.getBalance(ownerA.address);
  const execTx = await multisig.executeWithdrawal(id);
  console.log("   executeWithdrawal tx:", explorerTx(execTx.hash));
  const execReceipt = await execTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[5/5] Independently verifying the result on-chain...");
  const balAfterExec: bigint = await ethers.provider.getBalance(entry.address);
  const w = await multisig.withdrawals(id);
  const gasCost = execReceipt!.gasUsed * execReceipt!.gasPrice;
  const ownerABalAfterExec: bigint = await ethers.provider.getBalance(ownerA.address);
  const netReceived = ownerABalAfterExec - ownerABalBeforeExec + gasCost; // add back gas A itself paid

  console.log("   multisig balance after:", ethers.formatEther(balAfterExec), "ETH (expected", ethers.formatEther(balAfterFund - withdrawAmount), ")");
  console.log("   withdrawal.executed:", w.executed);
  console.log("   withdrawal.confirmations:", w.confirmations.toString(), "/ threshold", entry.threshold);
  console.log("   owner A net ETH received (excl. its own gas):", ethers.formatEther(netReceived), "(expected", ethers.formatEther(withdrawAmount), ")");

  const success =
    w.executed === true &&
    balAfterExec === balAfterFund - withdrawAmount &&
    netReceived === withdrawAmount;

  console.log(
    success
      ? "\n✅ TREASURY MULTISIG DEMO PASSED — a withdrawal needed a second owner's confirmation before it could execute, was rejected with only one, and moved the exact amount once threshold was met, live on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
