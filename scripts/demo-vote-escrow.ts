import { ethers } from "hardhat";
import { loadTokenStackDeployment, loadVoteEscrowDeployment, loadTreasuryMultisigDeployment } from "./lib/deployments";

/**
 * Live proof that AncillaVoteEscrow actually weights revenue by lock
 * COMMITMENT, not just amount — two wallets lock the same amount of
 * ANCILLA for different durations, and the one that locked longer earns
 * proportionally more of the same treasury distribution.
 *
 * Deliberately does NOT wait out a real lock maturity to prove
 * withdraw() — MIN_LOCK is 4 real weeks, genuinely impractical to sit
 * through in a demo script. That path (lock -> time passes -> withdraw
 * returns principal, accrued rewards survive the withdrawal) is proven
 * with Hardhat's simulated time instead, in
 * test/AncillaVoteEscrow.test.ts — this script proves the part that
 * can't be simulated away: the actual weighting and payout, live,
 * funded through the real treasury multisig.
 *
 * Usage:
 *   npx hardhat run scripts/demo-vote-escrow.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env, both owners of the
 * deployed AncillaTreasuryMultisig, and both holding enough ANCILLA to
 * lock (run scripts/demo-governor.ts first if not).
 */

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function main() {
  const stack = loadTokenStackDeployment("arbitrumSepolia");
  const escrowDeployment = loadVoteEscrowDeployment("arbitrumSepolia");
  const treasury = loadTreasuryMultisigDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [ownerA] = await ethers.getSigners();
  const ownerB = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla vote-escrow (lock-weighted revenue) live demo: Arbitrum Sepolia ==");
  console.log("AncillaToken:      ", stack.token, explorerAddr(stack.token));
  console.log("AncillaVoteEscrow: ", escrowDeployment.address, explorerAddr(escrowDeployment.address));
  console.log("Treasury multisig: ", treasury.address, explorerAddr(treasury.address));
  console.log("Locker A (short lock):", ownerA.address);
  console.log("Locker B (2x lock):   ", ownerB.address);

  const token = await ethers.getContractAt("AncillaToken", stack.token, ownerA);
  const tokenB = token.connect(ownerB);
  const escrow = await ethers.getContractAt("AncillaVoteEscrow", escrowDeployment.address, ownerA);
  const escrowB = escrow.connect(ownerB);
  const multisig = await ethers.getContractAt("AncillaTreasuryMultisig", treasury.address, ownerA);

  const isAOwner: boolean = await multisig.isOwner(ownerA.address);
  const isBOwner: boolean = await multisig.isOwner(ownerB.address);
  if (!isAOwner || !isBOwner) {
    throw new Error(`PRIVATE_KEY/AGENT_PRIVATE_KEY must both be treasury multisig owners. isOwner(A)=${isAOwner} isOwner(B)=${isBOwner}`);
  }

  const MIN_LOCK: bigint = await escrow.MIN_LOCK();
  const lockAmount = ethers.parseEther("100");

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Locker A locks 100 ANCILLA for the minimum duration (1x weight unit)...");
  const alreadyLockedA: [bigint, bigint, bigint] = await escrow.locks(ownerA.address);
  if (alreadyLockedA[0] === 0n) {
    const balA: bigint = await token.balanceOf(ownerA.address);
    if (balA < lockAmount) throw new Error(`Locker A only holds ${ethers.formatEther(balA)} ANCILLA — run scripts/demo-governor.ts first.`);
    await (await token.approve(escrowDeployment.address, lockAmount)).wait();
    const lockTxA = await escrow.lock(lockAmount, MIN_LOCK);
    console.log("   lock tx:", explorerTx(lockTxA.hash));
    await lockTxA.wait();
  } else {
    console.log("   already has an active lock from a previous run — reusing it.");
  }

  console.log("\n[2/6] Locker B locks the SAME 100 ANCILLA for 2x the duration (2x weight unit)...");
  const alreadyLockedB: [bigint, bigint, bigint] = await escrow.locks(ownerB.address);
  if (alreadyLockedB[0] === 0n) {
    const balB: bigint = await tokenB.balanceOf(ownerB.address);
    if (balB < lockAmount) throw new Error(`Locker B only holds ${ethers.formatEther(balB)} ANCILLA — run scripts/demo-governor.ts first.`);
    await (await tokenB.approve(escrowDeployment.address, lockAmount)).wait();
    const lockTxB = await escrowB.lock(lockAmount, MIN_LOCK * 2n);
    console.log("   lock tx:", explorerTx(lockTxB.hash));
    await lockTxB.wait();
  } else {
    console.log("   already has an active lock from a previous run — reusing it.");
  }

  const lockA = await escrow.locks(ownerA.address);
  const lockB = await escrow.locks(ownerB.address);
  console.log(`   weight A: ${ethers.formatEther(lockA.weight)}, weight B: ${ethers.formatEther(lockB.weight)} (expect B ≈ 2x A)`);

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Funding the treasury multisig with a small amount of test ETH...");
  const fundAmount = ethers.parseEther("0.0006");
  await (await ownerA.sendTransaction({ to: treasury.address, value: fundAmount })).wait();

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Owner A proposes sending part of it to AncillaVoteEscrow (revenue distribution)...");
  const distributeAmount = ethers.parseEther("0.0003");
  const earnedBeforeA: bigint = await escrow.earned(ownerA.address);
  const earnedBeforeB: bigint = await escrow.earned(ownerB.address);
  const proposeTx = await multisig.proposeWithdrawal(escrowDeployment.address, distributeAmount);
  console.log("   proposeWithdrawal tx:", explorerTx(proposeTx.hash));
  await proposeTx.wait();
  const id: bigint = (await multisig.withdrawalCount()) - 1n;

  console.log("\n[5/6] Owner B confirms, Owner A executes (2-of-3 reached)...");
  await (await multisig.connect(ownerB).confirmWithdrawal(id)).wait();
  const executeTx = await multisig.executeWithdrawal(id);
  console.log("   executeWithdrawal tx:", explorerTx(executeTx.hash));
  await executeTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Verifying independently: B earned roughly 2x what A earned from the SAME distribution...");
  const deltaA = (await escrow.earned(ownerA.address)) - earnedBeforeA;
  const deltaB = (await escrow.earned(ownerB.address)) - earnedBeforeB;
  console.log(`   A earned: ${ethers.formatEther(deltaA)} ETH`);
  console.log(`   B earned: ${ethers.formatEther(deltaB)} ETH`);
  const ratio = Number(deltaB) / Number(deltaA);
  console.log(`   ratio B/A: ${ratio.toFixed(3)} (expected ≈ 2.0 — same amount locked, 2x the duration)`);

  const success = deltaA > 0n && Math.abs(ratio - 2) < 0.01;
  console.log(
    success
      ? "\n✅ VOTE-ESCROW DEMO PASSED — the longer lock earned proportionally more of the identical distribution, live on Arbitrum Sepolia, funded through the real treasury multisig."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
