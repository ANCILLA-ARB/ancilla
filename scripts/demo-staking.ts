import { ethers } from "hardhat";
import { loadTokenStackDeployment, loadTreasuryMultisigDeployment } from "./lib/deployments";

/**
 * Live proof that AncillaStaking's revenue-share actually works end to
 * end, funded through AncillaTreasuryMultisig's EXISTING withdrawal flow
 * — no changes needed to that contract for this to work, since it sends
 * plain ETH with no calldata, which lands in AncillaStaking's receive().
 *
 * Sequence: stake ANCILLA -> treasury multisig proposes+confirms+executes
 * a withdrawal TO the staking contract (2-of-3, same live governance
 * already proven in demo-treasury.ts) -> independently verify the
 * staker's earned() balance grew by the distributed amount -> claim it
 * and verify the real ETH balance delta, not the return value.
 *
 * Usage:
 *   npx hardhat run scripts/demo-staking.ts --network arbitrumSepolia
 *
 * Requires PRIVATE_KEY and AGENT_PRIVATE_KEY in .env — both must be
 * owners of the deployed AncillaTreasuryMultisig (true for
 * TREASURY_MULTISIG_OWNERS as configured). Requires the staker (Owner A)
 * to already hold ANCILLA — run scripts/demo-governor.ts first if not
 * (its first run mints demo voting power to both wallets).
 */

function explorerTx(hash: string) {
  return `https://sepolia.arbiscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.arbiscan.io/address/${addr}`;
}

async function main() {
  const stack = loadTokenStackDeployment("arbitrumSepolia");
  const treasury = loadTreasuryMultisigDeployment("arbitrumSepolia");
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const [ownerA] = await ethers.getSigners();
  const ownerB = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla staking / revenue-share live demo: Arbitrum Sepolia ==");
  console.log("AncillaToken:  ", stack.token, explorerAddr(stack.token));
  console.log("AncillaStaking:", stack.staking, explorerAddr(stack.staking));
  console.log("Treasury multisig:", treasury.address, explorerAddr(treasury.address));
  console.log("Staker / Owner A: ", ownerA.address);
  console.log("Owner B (co-confirmer):", ownerB.address);

  const token = await ethers.getContractAt("AncillaToken", stack.token, ownerA);
  const staking = await ethers.getContractAt("AncillaStaking", stack.staking, ownerA);
  const multisig = await ethers.getContractAt("AncillaTreasuryMultisig", treasury.address, ownerA);

  const isAOwner: boolean = await multisig.isOwner(ownerA.address);
  const isBOwner: boolean = await multisig.isOwner(ownerB.address);
  if (!isAOwner || !isBOwner) {
    throw new Error(`PRIVATE_KEY/AGENT_PRIVATE_KEY must both be treasury multisig owners. isOwner(A)=${isAOwner} isOwner(B)=${isBOwner}`);
  }

  // ---------------------------------------------------------------------
  console.log("\n[1/6] Staking ANCILLA (if not already staked from a previous run)...");
  const stakeAmount = ethers.parseEther("100");
  const alreadyStaked: bigint = await staking.staked(ownerA.address);
  if (alreadyStaked === 0n) {
    const bal: bigint = await token.balanceOf(ownerA.address);
    if (bal < stakeAmount) {
      throw new Error(
        `Owner A only holds ${ethers.formatEther(bal)} ANCILLA, need ${ethers.formatEther(stakeAmount)} to stake — run scripts/demo-governor.ts first.`
      );
    }
    await (await token.approve(stack.staking, stakeAmount)).wait();
    const stakeTx = await staking.stake(stakeAmount);
    console.log("   stake tx:", explorerTx(stakeTx.hash));
    await stakeTx.wait();
  } else {
    console.log("   already staked", ethers.formatEther(alreadyStaked), "ANCILLA from a previous run — reusing it.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[2/6] Funding the treasury multisig with a small amount of test ETH...");
  const fundAmount = ethers.parseEther("0.0006");
  const fundTx = await ownerA.sendTransaction({ to: treasury.address, value: fundAmount });
  console.log("   tx:", explorerTx(fundTx.hash));
  await fundTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[3/6] Owner A proposes sending part of it to AncillaStaking (this IS the revenue distribution)...");
  const distributeAmount = ethers.parseEther("0.0004");
  const earnedBefore: bigint = await staking.earned(ownerA.address);
  const proposeTx = await multisig.proposeWithdrawal(stack.staking, distributeAmount);
  console.log("   proposeWithdrawal tx:", explorerTx(proposeTx.hash));
  await proposeTx.wait();
  const id: bigint = (await multisig.withdrawalCount()) - 1n;

  // ---------------------------------------------------------------------
  console.log("\n[4/6] Owner B confirms, Owner A executes (2-of-3 reached)...");
  await (await multisig.connect(ownerB).confirmWithdrawal(id)).wait();
  const executeTx = await multisig.executeWithdrawal(id);
  console.log("   executeWithdrawal tx:", explorerTx(executeTx.hash));
  await executeTx.wait();

  // ---------------------------------------------------------------------
  console.log("\n[5/6] Independently verifying the staker's earned() balance grew by exactly that amount...");
  const earnedAfter: bigint = await staking.earned(ownerA.address);
  const delta = earnedAfter - earnedBefore;
  console.log(`   earned() delta: ${ethers.formatEther(delta)} ETH (expected ${ethers.formatEther(distributeAmount)})`);

  // ---------------------------------------------------------------------
  console.log("\n[6/6] Claiming it, verified via real ETH balance delta, not the return value...");
  const balBeforeClaim: bigint = await ethers.provider.getBalance(ownerA.address);
  const claimTx = await staking.claim();
  console.log("   claim tx:", explorerTx(claimTx.hash));
  const claimReceipt = await claimTx.wait();
  const gasCost = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
  const balAfterClaim: bigint = await ethers.provider.getBalance(ownerA.address);
  const netGain = balAfterClaim - balBeforeClaim + gasCost;
  console.log(`   real ETH gained (gas-cost-adjusted): ${ethers.formatEther(netGain)} ETH`);

  const success = delta === distributeAmount && netGain === distributeAmount;
  console.log(
    success
      ? "\n✅ STAKING DEMO PASSED — a real 2-of-3 treasury withdrawal, sent with no special-cased calldata, was correctly picked up as revenue and paid out to the staker, live on Arbitrum Sepolia."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
