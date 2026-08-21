import { ethers } from "hardhat";
import { buildIntent } from "../sdk/intent";
import { loadIntentCommitRevealDeployment, loadSwapStackDeployment } from "./lib/deployments";

/**
 * The final live proof for the project's actual core narrative: a
 * privacy-preserving swap intent, committed on Arbitrum Sepolia (only its
 * hash visible), revealed inside its batch window, and — unlike every
 * earlier demo, which used MockExecutor — a REAL swap executes against a
 * REAL (if minimal) AMM, with output verified against an independently
 * computed constant-product value, not just "the contract agrees with
 * itself."
 *
 * Everything up to this script had already been proven live except this
 * exact path — AncillaSwapPool/SwapExecutor had only ever been exercised
 * against Hardhat's in-process network. This closes that gap.
 *
 * Usage:
 *   npx hardhat run scripts/demo-swap.ts --network arbitrumSepolia
 *
 * Requires:
 *   - PRIVATE_KEY in .env, funded (this script also uses it to seed pool
 *     liquidity and to top up AGENT_PRIVATE_KEY's wallet with a little ETH)
 *   - AGENT_PRIVATE_KEY in .env — a second, distinct wallet
 *   - deployments/arbitrumSepolia.json populated by both scripts/deploy.ts
 *     and scripts/deploy-swap.ts
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
  const agentPk = process.env.AGENT_PRIVATE_KEY;
  if (!agentPk) throw new Error("AGENT_PRIVATE_KEY not set in .env");

  const intentDeployment = loadIntentCommitRevealDeployment("arbitrumSepolia");
  const swapDeployment = loadSwapStackDeployment("arbitrumSepolia");

  const [lp] = await ethers.getSigners(); // from PRIVATE_KEY, also plays "liquidity provider"
  const agent = new ethers.Wallet(agentPk, ethers.provider);

  console.log("== Ancilla live REAL-SWAP demo: Arbitrum Sepolia ==");
  console.log("LP/relay wallet:", lp.address);
  console.log("Agent wallet:   ", agent.address);
  if (agent.address.toLowerCase() === lp.address.toLowerCase()) {
    throw new Error("Agent and LP wallets must be different.");
  }

  const contract = await ethers.getContractAt("IntentCommitReveal", intentDeployment.address, lp);
  const tokenA = await ethers.getContractAt("TestToken", swapDeployment.tokenA, lp);
  const tokenB = await ethers.getContractAt("TestToken", swapDeployment.tokenB, lp);
  const pool = await ethers.getContractAt("AncillaSwapPool", swapDeployment.pool, lp);

  console.log("IntentCommitReveal:", intentDeployment.address, explorerAddr(intentDeployment.address));
  console.log("AncillaSwapPool:   ", swapDeployment.pool, explorerAddr(swapDeployment.pool));
  console.log("SwapExecutor:      ", swapDeployment.executor, explorerAddr(swapDeployment.executor));

  // ---------------------------------------------------------------------
  console.log("\n[1/7] Ensuring the pool has liquidity...");
  let reserveA: bigint = await pool.reserveA();
  let reserveB: bigint = await pool.reserveB();
  if (reserveA === 0n || reserveB === 0n) {
    const seedA = ethers.parseUnits("100000", 18);
    const seedB = ethers.parseUnits("50", 18);
    console.log("   pool empty, seeding", ethers.formatUnits(seedA, 18), "aUSD +", ethers.formatUnits(seedB, 18), "aETH...");
    await (await tokenA.mint(lp.address, seedA)).wait();
    await (await tokenB.mint(lp.address, seedB)).wait();
    await (await tokenA.approve(swapDeployment.pool, seedA)).wait();
    await (await tokenB.approve(swapDeployment.pool, seedB)).wait();
    const tx = await pool.addLiquidity(seedA, seedB);
    console.log("   addLiquidity tx:", explorerTx(tx.hash));
    await tx.wait();
    reserveA = await pool.reserveA();
    reserveB = await pool.reserveB();
  }
  console.log("   reserves:", ethers.formatUnits(reserveA, 18), "aUSD /", ethers.formatUnits(reserveB, 18), "aETH");

  // ---------------------------------------------------------------------
  console.log("\n[2/7] Making sure the agent wallet has enough ETH for its own gas...");
  const agentEthBal = await ethers.provider.getBalance(agent.address);
  console.log("   agent ETH balance:", ethers.formatEther(agentEthBal));
  if (agentEthBal < ethers.parseEther("0.0015")) {
    const topUp = ethers.parseEther("0.002");
    console.log("   topping up agent with", ethers.formatEther(topUp), "ETH from LP wallet...");
    const tx = await lp.sendTransaction({ to: agent.address, value: topUp });
    console.log("   tx:", explorerTx(tx.hash));
    await tx.wait();
  }

  // ---------------------------------------------------------------------
  console.log("\n[3/7] Agent obtains aUSD to swap, and bonds in IntentCommitReveal...");
  const amountIn = ethers.parseUnits("1000", 18); // 1000 aUSD
  await (await tokenA.mint(agent.address, amountIn)).wait();
  console.log("   minted", ethers.formatUnits(amountIn, 18), "aUSD to agent");

  const contractAsAgent = contract.connect(agent);
  const minBond: bigint = await contract.minBond();
  const lockedBond: bigint = await contract.lockedBond(agent.address);
  const currentBond: bigint = await contract.bondBalance(agent.address);
  const needed = lockedBond + minBond;
  if (currentBond < needed) {
    const tx = await contractAsAgent.depositBond({ value: needed - currentBond });
    console.log("   depositBond tx:", explorerTx(tx.hash));
    await tx.wait();
  } else {
    console.log("   already sufficiently bonded.");
  }

  // ---------------------------------------------------------------------
  console.log("\n[4/7] Agent approves SwapExecutor to pull the aUSD, and commits the swap intent...");
  const tokenAAsAgent = tokenA.connect(agent);
  await (await (tokenAAsAgent as any).approve(swapDeployment.executor, amountIn)).wait();
  console.log("   approved SwapExecutor for", ethers.formatUnits(amountIn, 18), "aUSD");

  // Quote first — same as any real client would before committing to a
  // hidden intent, so minAmountOut reflects the actual pool state now.
  const expectedOut: bigint = await pool.getAmountOut(amountIn, reserveA, reserveB);
  console.log("   quoted output:", ethers.formatUnits(expectedOut, 18), "aETH");

  const intentData = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256"],
    [swapDeployment.tokenA, amountIn, expectedOut]
  );
  const nonce = Date.now();
  const built = buildIntent(agent.address, intentData, nonce);
  console.log("   commitId:", built.commitId, "(only this hash is visible on-chain right now — not the token, amount, or price)");

  // Snapshot BEFORE committing — the agent wallet is reused across this
  // repo's demos, so it may already hold aUSD/aETH from an earlier run.
  // Checking the DELTA, not an absolute balance, is what's actually being
  // proven here. (An earlier version of this script asserted an absolute
  // zero/expected balance instead and would have false-failed once the
  // wallet had leftover balance from a prior run — the same mistake was
  // caught and fixed in demo-hook-swap.ts first; documented in the README
  // rather than silently patched.)
  const agentTokenABalBefore: bigint = await tokenA.balanceOf(agent.address);
  const agentTokenBBalBefore: bigint = await tokenB.balanceOf(agent.address);

  const commitTx = await contractAsAgent.commitIntent(built.commitId, built.commitHash);
  console.log("   commitIntent tx:", explorerTx(commitTx.hash));
  await commitTx.wait();

  const epoch: bigint = await contract.currentEpoch();
  const openTime: bigint = await contract.revealOpenTimeOf(epoch);
  const closeTime: bigint = await contract.revealCloseTimeOf(epoch);
  console.log(`   epoch ${epoch} — reveal window: [${openTime}, ${closeTime}) (unix seconds)`);

  // ---------------------------------------------------------------------
  console.log("\n[5/7] Waiting for the shared batch reveal window to open...");
  await waitForTimestamp(openTime, "reveal opens");

  // ---------------------------------------------------------------------
  console.log("\n[6/7] Revealing — this is the moment the swap actually happens...");
  const revealTx = await contractAsAgent.revealIntent(built.commitId, built.intentData, built.salt, swapDeployment.executor);
  console.log("   revealIntent tx:", explorerTx(revealTx.hash));
  const revealReceipt = await revealTx.wait();
  console.log("   confirmed in block", revealReceipt!.blockNumber);

  // ---------------------------------------------------------------------
  console.log("\n[7/7] Independently verifying the swap actually happened, on-chain...");
  const agentTokenABalAfter: bigint = await tokenA.balanceOf(agent.address);
  const agentTokenBBalAfter: bigint = await tokenB.balanceOf(agent.address);
  const aUsdSpent = agentTokenABalBefore - agentTokenABalAfter;
  const aEthReceived = agentTokenBBalAfter - agentTokenBBalBefore;
  console.log("   agent aUSD spent:", ethers.formatUnits(aUsdSpent, 18), "(expected exactly", ethers.formatUnits(amountIn, 18), ")");
  console.log("   agent aETH received:", ethers.formatUnits(aEthReceived, 18), "(expected exactly", ethers.formatUnits(expectedOut, 18), ")");

  const swapEvents = await pool.queryFilter(pool.filters.Swap(), revealReceipt!.blockNumber, revealReceipt!.blockNumber);
  const executedEvents = await (await ethers.getContractAt("SwapExecutor", swapDeployment.executor)).queryFilter(
    (await ethers.getContractAt("SwapExecutor", swapDeployment.executor)).filters.IntentSwapExecuted(),
    revealReceipt!.blockNumber,
    revealReceipt!.blockNumber
  );

  const stored = await contract.commitments(built.commitId);
  const success =
    stored.revealed === true &&
    aUsdSpent === amountIn &&
    aEthReceived === expectedOut &&
    swapEvents.length === 1 &&
    executedEvents.length === 1;

  console.log("   commitments(commitId).revealed =", stored.revealed);
  console.log("   AncillaSwapPool 'Swap' events found:", swapEvents.length);
  console.log("   SwapExecutor 'IntentSwapExecuted' events found:", executedEvents.length);

  console.log(
    success
      ? "\n✅ REAL SWAP DEMO PASSED — a privacy-preserving intent was committed, revealed inside its batch window, and executed a real constant-product swap live on Arbitrum Sepolia, verified independently on-chain."
      : "\n❌ DEMO FAILED — see output above."
  );
  if (!success) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
