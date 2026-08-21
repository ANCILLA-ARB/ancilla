import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { buildIntent } from "../sdk/intent";

/**
 * Tests for the first REAL (non-mock) IIntentExecutor in this repo:
 * AncillaSwapPool (a minimal constant-product AMM) + SwapExecutor (bridges
 * a revealed Ancilla intent to an actual swap against that pool).
 *
 * Structure: pool unit tests, executor unit tests, then a full
 * commit -> batch reveal window -> reveal -> REAL swap integration test
 * against the actual IntentCommitReveal contract — proving the whole
 * narrative (privacy-preserving DeFi intent -> real execution) works
 * end-to-end, not just "the hash matched."
 */

const COMMIT_WINDOW = 300;
const REVEAL_DELAY = 60;
const REVEAL_WINDOW = 300;
const MIN_BOND = ethers.parseEther("0.1");

async function deployTokensAndPool() {
  const [deployer, lp, trader] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("TestToken");
  const tokenA = await Token.deploy("Ancilla Test USD", "aUSD");
  await tokenA.waitForDeployment();
  const tokenB = await Token.deploy("Ancilla Test ETH", "aETH");
  await tokenB.waitForDeployment();

  const Pool = await ethers.getContractFactory("AncillaSwapPool");
  const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress());
  await pool.waitForDeployment();

  return { deployer, lp, trader, tokenA, tokenB, pool };
}

/** Same formula as AncillaSwapPool.getAmountOut, computed independently in
 *  JS so tests aren't just "the contract agrees with itself." */
function expectedAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

describe("AncillaSwapPool", function () {
  it("rejects a pool with identical tokens", async function () {
    const { tokenA } = await loadFixture(deployTokensAndPool);
    const Pool = await ethers.getContractFactory("AncillaSwapPool");
    const tokenAAddr = await tokenA.getAddress();
    await expect(Pool.deploy(tokenAAddr, tokenAAddr)).to.be.revertedWithCustomError(Pool, "IdenticalTokens");
  });

  it("rejects a pool with tokenB as the zero address", async function () {
    const { tokenA } = await loadFixture(deployTokensAndPool);
    const Pool = await ethers.getContractFactory("AncillaSwapPool");
    await expect(Pool.deploy(await tokenA.getAddress(), ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Pool,
      "ZeroAddress"
    );
  });

  it("rejects a pool with tokenA as the zero address (the other half of the OR check)", async function () {
    const { tokenB } = await loadFixture(deployTokensAndPool);
    const Pool = await ethers.getContractFactory("AncillaSwapPool");
    await expect(Pool.deploy(ethers.ZeroAddress, await tokenB.getAddress())).to.be.revertedWithCustomError(
      Pool,
      "ZeroAddress"
    );
  });

  describe("addLiquidity", function () {
    it("accepts liquidity and updates reserves", async function () {
      const { lp, tokenA, tokenB, pool } = await loadFixture(deployTokensAndPool);
      const poolAddr = await pool.getAddress();
      const amountA = ethers.parseUnits("10000", 18);
      const amountB = ethers.parseUnits("5", 18);

      await tokenA.mint(lp.address, amountA);
      await tokenB.mint(lp.address, amountB);
      await tokenA.connect(lp).approve(poolAddr, amountA);
      await tokenB.connect(lp).approve(poolAddr, amountB);

      await expect(pool.connect(lp).addLiquidity(amountA, amountB))
        .to.emit(pool, "LiquidityAdded")
        .withArgs(lp.address, amountA, amountB);

      expect(await pool.reserveA()).to.equal(amountA);
      expect(await pool.reserveB()).to.equal(amountB);
      expect(await tokenA.balanceOf(poolAddr)).to.equal(amountA);
      expect(await tokenB.balanceOf(poolAddr)).to.equal(amountB);
    });

    it("rejects zero amounts", async function () {
      const { lp, pool } = await loadFixture(deployTokensAndPool);
      await expect(pool.connect(lp).addLiquidity(0, 100)).to.be.revertedWithCustomError(pool, "ZeroAmount");
      await expect(pool.connect(lp).addLiquidity(100, 0)).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });
  });

  describe("swap", function () {
    async function seededPool() {
      const base = await loadFixture(deployTokensAndPool);
      const { lp, tokenA, tokenB, pool } = base;
      const poolAddr = await pool.getAddress();
      const reserveA = ethers.parseUnits("100000", 18); // 100,000 aUSD
      const reserveB = ethers.parseUnits("50", 18); // 50 aETH -> price 2000 aUSD/aETH

      await tokenA.mint(lp.address, reserveA);
      await tokenB.mint(lp.address, reserveB);
      await tokenA.connect(lp).approve(poolAddr, reserveA);
      await tokenB.connect(lp).approve(poolAddr, reserveB);
      await pool.connect(lp).addLiquidity(reserveA, reserveB);

      return { ...base, reserveA, reserveB };
    }

    it("swaps tokenA for tokenB matching the constant-product formula exactly", async function () {
      const { trader, tokenA, tokenB, pool, reserveA, reserveB } = await seededPool();
      const poolAddr = await pool.getAddress();
      const amountIn = ethers.parseUnits("1000", 18); // 1000 aUSD in

      await tokenA.mint(trader.address, amountIn);
      await tokenA.connect(trader).approve(poolAddr, amountIn);

      const expected = expectedAmountOut(amountIn, reserveA, reserveB);
      expect(expected).to.be.greaterThan(0n);

      const tx = await pool.connect(trader).swap(await tokenA.getAddress(), amountIn, expected, trader.address);
      await expect(tx)
        .to.emit(pool, "Swap")
        .withArgs(trader.address, await tokenA.getAddress(), amountIn, await tokenB.getAddress(), expected, trader.address);

      expect(await tokenB.balanceOf(trader.address)).to.equal(expected);
      expect(await tokenA.balanceOf(trader.address)).to.equal(0n);
      expect(await pool.reserveA()).to.equal(reserveA + amountIn);
      expect(await pool.reserveB()).to.equal(reserveB - expected);
    });

    it("rejects a swap for a token that isn't part of the pair", async function () {
      const { trader, pool } = await seededPool();
      const Token = await ethers.getContractFactory("TestToken");
      const randomToken = await Token.deploy("Random", "RND");
      await randomToken.waitForDeployment();

      await expect(
        pool.connect(trader).swap(await randomToken.getAddress(), 100, 0, trader.address)
      ).to.be.revertedWithCustomError(pool, "UnknownToken");
    });

    it("rejects a swap whose output would fall below minAmountOut (slippage protection)", async function () {
      const { trader, tokenA, pool, reserveA, reserveB } = await seededPool();
      const poolAddr = await pool.getAddress();
      const amountIn = ethers.parseUnits("1000", 18);
      await tokenA.mint(trader.address, amountIn);
      await tokenA.connect(trader).approve(poolAddr, amountIn);

      const expected = expectedAmountOut(amountIn, reserveA, reserveB);
      await expect(
        pool.connect(trader).swap(await tokenA.getAddress(), amountIn, expected + 1n, trader.address)
      ).to.be.revertedWithCustomError(pool, "SlippageExceeded");
    });

    it("rejects a swap without sufficient allowance (agent never approved the pool)", async function () {
      const { trader, tokenA, pool } = await seededPool();
      const amountIn = ethers.parseUnits("1000", 18);
      await tokenA.mint(trader.address, amountIn);
      // no approve() call

      await expect(pool.connect(trader).swap(await tokenA.getAddress(), amountIn, 0, trader.address)).to.be.reverted;
    });

    it("swaps tokenB for tokenA too (the reverse direction) — not just the one direction every other test happens to exercise", async function () {
      const { trader, tokenA, tokenB, pool, reserveA, reserveB } = await seededPool();
      const poolAddr = await pool.getAddress();
      const amountIn = ethers.parseUnits("1", 18); // 1 aETH in

      await tokenB.mint(trader.address, amountIn);
      await tokenB.connect(trader).approve(poolAddr, amountIn);

      // Note the swapped argument order vs. the tokenA->tokenB test:
      // reserveIn/reserveOut are reserveB/reserveA here.
      const expected = expectedAmountOut(amountIn, reserveB, reserveA);
      expect(expected).to.be.greaterThan(0n);

      await expect(pool.connect(trader).swap(await tokenB.getAddress(), amountIn, expected, trader.address))
        .to.emit(pool, "Swap")
        .withArgs(trader.address, await tokenB.getAddress(), amountIn, await tokenA.getAddress(), expected, trader.address);

      expect(await tokenA.balanceOf(trader.address)).to.equal(expected);
      expect(await pool.reserveB()).to.equal(reserveB + amountIn);
      expect(await pool.reserveA()).to.equal(reserveA - expected);
    });

    it("rejects getAmountOut / swap against a pool with no liquidity yet (the actually-reachable InsufficientLiquidity path)", async function () {
      // A test originally tried to trigger swap()'s
      // `if (amountOut >= reserveOut) revert InsufficientLiquidity()` guard
      // with an absurdly large amountIn, assuming that would push amountOut
      // past reserveOut. Checked the actual arithmetic first (BigInt in a
      // throwaway script, amountIn up to 1e40 tokens) instead of trusting
      // the intuition: it doesn't work. The constant-product-with-fee
      // formula is asymptotic — amountOut strictly approaches reserveOut as
      // amountIn grows but, under integer (floor) division, never reaches
      // it. That specific guard in `swap()` is unreachable by design given
      // the formula upstream of it — see the comment on it in
      // AncillaSwapPool.sol. It stays as defense-in-depth (the same pattern
      // as the bond-locking fix's `if (penalty > bal)` fallback), not
      // because it's expected to fire.
      //
      // The genuinely reachable InsufficientLiquidity path is
      // getAmountOut's own zero-reserve check, hit by swapping against a
      // pool nothing has ever added liquidity to.
      const { trader, tokenA, tokenB, pool } = await loadFixture(deployTokensAndPool);
      const poolAddr = await pool.getAddress();
      await tokenA.mint(trader.address, 100n);
      await tokenA.connect(trader).approve(poolAddr, 100n);

      await expect(pool.getAmountOut(100n, 0n, 0n)).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
      await expect(
        pool.connect(trader).swap(await tokenA.getAddress(), 100n, 0n, trader.address)
      ).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("getAmountOut rejects each individual zero-reserve combination, not just both at once", async function () {
      const { pool } = await loadFixture(deployTokensAndPool);
      // The "both zero" case is already covered above; the OR check
      // (`reserveIn == 0 || reserveOut == 0`) needs each side exercised
      // independently too for full branch coverage.
      await expect(pool.getAmountOut(100n, 0n, 500n)).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
      await expect(pool.getAmountOut(100n, 500n, 0n)).to.be.revertedWithCustomError(pool, "InsufficientLiquidity");
    });

    it("getAmountOut rejects a zero amountIn directly (not just via addLiquidity's separate zero-amount check)", async function () {
      const { pool } = await loadFixture(deployTokensAndPool);
      await expect(pool.getAmountOut(0n, 500n, 500n)).to.be.revertedWithCustomError(pool, "ZeroAmount");
    });

    it("rejects a swap to the zero address as recipient", async function () {
      const { trader, tokenA, pool } = await seededPool();
      const poolAddr = await pool.getAddress();
      const amountIn = ethers.parseUnits("100", 18);
      await tokenA.mint(trader.address, amountIn);
      await tokenA.connect(trader).approve(poolAddr, amountIn);

      await expect(
        pool.connect(trader).swap(await tokenA.getAddress(), amountIn, 0, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(pool, "ZeroAddress");
    });
  });

  describe("reentrancy (deliberately trying to break the pool, not just asserting it's safe)", function () {
    it("blocks a token from reentering swap() mid-transfer", async function () {
      // Standard OpenZeppelin ERC20 (TestToken, used everywhere else in
      // this suite) has no transfer hooks, so it can never exercise this
      // path — same reasoning as ReentrantAttacker.sol for
      // IntentCommitReveal. ReentrantToken is a minimal, self-contained,
      // hook-having "ERC20" built specifically to attempt this.
      const [, trader] = await ethers.getSigners();

      const ReentrantTokenFactory = await ethers.getContractFactory("ReentrantToken");
      const reentrantToken = await ReentrantTokenFactory.deploy();
      await reentrantToken.waitForDeployment();
      const reentrantTokenAddr = await reentrantToken.getAddress();

      const Token = await ethers.getContractFactory("TestToken");
      const tokenB = await Token.deploy("Ancilla Test ETH", "aETH");
      await tokenB.waitForDeployment();

      const Pool = await ethers.getContractFactory("AncillaSwapPool");
      const pool = await Pool.deploy(reentrantTokenAddr, await tokenB.getAddress());
      await pool.waitForDeployment();
      const poolAddr = await pool.getAddress();

      // Seed liquidity normally — no reentrancy involved in this part.
      const reserveA = ethers.parseUnits("100000", 18);
      const reserveB = ethers.parseUnits("50", 18);
      await reentrantToken.mint(trader.address, reserveA);
      await tokenB.mint(trader.address, reserveB);
      await reentrantToken.connect(trader).approve(poolAddr, reserveA);
      await tokenB.connect(trader).approve(poolAddr, reserveB);
      await pool.connect(trader).addLiquidity(reserveA, reserveB);

      // Give the TOKEN CONTRACT ITSELF a funded, self-approved balance, so
      // its reentrant call below has valid preconditions and would succeed
      // if nothing were blocking it — otherwise a failure could just mean
      // "the reentrant call had no funds," not "the guard caught it."
      const reentryAmount = ethers.parseUnits("10", 18);
      await reentrantToken.mint(reentrantTokenAddr, reentryAmount);
      await reentrantToken.selfApprove(poolAddr, reentryAmount);
      const reentryCalldata = pool.interface.encodeFunctionData("swap", [
        reentrantTokenAddr,
        reentryAmount,
        0,
        trader.address,
      ]);
      await reentrantToken.setReentry(poolAddr, reentryCalldata);

      // The outer swap, from a normal trader.
      const outerAmountIn = ethers.parseUnits("100", 18);
      await reentrantToken.mint(trader.address, outerAmountIn);
      await reentrantToken.connect(trader).approve(poolAddr, outerAmountIn);

      const tx = await pool.connect(trader).swap(reentrantTokenAddr, outerAmountIn, 0, trader.address);
      await tx.wait(); // outer call succeeds

      // The reentrant attempt, fired from inside the outer call's
      // transferFrom, must have failed — proving the guard actually
      // blocked it, not just that nothing tried.
      expect(await reentrantToken.reentrySucceeded()).to.equal(false);
    });
  });
});

describe("SwapExecutor", function () {
  async function deployExecutor() {
    const base = await deployTokensAndPool();
    const { tokenA, tokenB, pool } = base;
    const Executor = await ethers.getContractFactory("SwapExecutor");
    const executor = await Executor.deploy(await pool.getAddress());
    await executor.waitForDeployment();
    return { ...base, executor };
  }

  it("rejects a zero-address pool at construction", async function () {
    const Executor = await ethers.getContractFactory("SwapExecutor");
    await expect(Executor.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Executor, "PoolIsZeroAddress");
  });

  it("rejects malformed intentData (wrong length)", async function () {
    const { executor, deployer } = await loadFixture(deployExecutor);
    await expect(executor.executeIntent(deployer.address, "0x1234")).to.be.revertedWithCustomError(
      executor,
      "IntentDataMalformed"
    );
  });

  it("pulls tokenIn from the agent, swaps, and sends output back to the agent", async function () {
    const { lp, trader, tokenA, tokenB, pool, executor } = await loadFixture(deployExecutor);
    const poolAddr = await pool.getAddress();
    const executorAddr = await executor.getAddress();

    const reserveA = ethers.parseUnits("100000", 18);
    const reserveB = ethers.parseUnits("50", 18);
    await tokenA.mint(lp.address, reserveA);
    await tokenB.mint(lp.address, reserveB);
    await tokenA.connect(lp).approve(poolAddr, reserveA);
    await tokenB.connect(lp).approve(poolAddr, reserveB);
    await pool.connect(lp).addLiquidity(reserveA, reserveB);

    const amountIn = ethers.parseUnits("1000", 18);
    await tokenA.mint(trader.address, amountIn);
    // Agent approves the EXECUTOR, not the pool directly — the executor
    // pulls from the agent, then approves/forwards to the pool itself.
    await tokenA.connect(trader).approve(executorAddr, amountIn);

    const expected = expectedAmountOut(amountIn, reserveA, reserveB);
    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256"],
      [await tokenA.getAddress(), amountIn, expected]
    );

    const tx = await executor.executeIntent(trader.address, intentData);
    await expect(tx)
      .to.emit(executor, "IntentSwapExecuted")
      .withArgs(trader.address, await tokenA.getAddress(), amountIn, expected);

    expect(await tokenB.balanceOf(trader.address)).to.equal(expected);
    expect(await tokenA.balanceOf(trader.address)).to.equal(0n);
    expect(await tokenA.balanceOf(executorAddr)).to.equal(0n); // nothing left stuck in the executor
  });

  it("reverts (doesn't silently no-op) if the agent never approved the executor", async function () {
    const { lp, trader, tokenA, tokenB, pool, executor } = await loadFixture(deployExecutor);
    const poolAddr = await pool.getAddress();

    await tokenA.mint(lp.address, ethers.parseUnits("1000", 18));
    await tokenB.mint(lp.address, ethers.parseUnits("1", 18));
    await tokenA.connect(lp).approve(poolAddr, ethers.parseUnits("1000", 18));
    await tokenB.connect(lp).approve(poolAddr, ethers.parseUnits("1", 18));
    await pool.connect(lp).addLiquidity(ethers.parseUnits("1000", 18), ethers.parseUnits("1", 18));

    const amountIn = ethers.parseUnits("100", 18);
    await tokenA.mint(trader.address, amountIn);
    // deliberately no approve() to the executor

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256"],
      [await tokenA.getAddress(), amountIn, 0]
    );
    await expect(executor.executeIntent(trader.address, intentData)).to.be.reverted;
  });
});

describe("Full narrative: private swap intent, batched, then really executed", function () {
  it("commits a swap intent privately, reveals it once the batch window opens, and the swap actually happens with correct AMM output", async function () {
    const [treasury, agent, lp] = await ethers.getSigners();

    const Contract = await ethers.getContractFactory("IntentCommitReveal");
    const contract = await Contract.deploy(COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, treasury.address);
    await contract.waitForDeployment();

    const Token = await ethers.getContractFactory("TestToken");
    const tokenA = await Token.deploy("Ancilla Test USD", "aUSD");
    await tokenA.waitForDeployment();
    const tokenB = await Token.deploy("Ancilla Test ETH", "aETH");
    await tokenB.waitForDeployment();

    const Pool = await ethers.getContractFactory("AncillaSwapPool");
    const pool = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress());
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();

    const Executor = await ethers.getContractFactory("SwapExecutor");
    const executor = await Executor.deploy(poolAddr);
    await executor.waitForDeployment();
    const executorAddr = await executor.getAddress();

    // Seed the pool.
    const reserveA = ethers.parseUnits("100000", 18);
    const reserveB = ethers.parseUnits("50", 18);
    await tokenA.mint(lp.address, reserveA);
    await tokenB.mint(lp.address, reserveB);
    await tokenA.connect(lp).approve(poolAddr, reserveA);
    await tokenB.connect(lp).approve(poolAddr, reserveB);
    await pool.connect(lp).addLiquidity(reserveA, reserveB);

    // Agent prepares its swap: 1000 aUSD -> aETH, with a real minAmountOut
    // computed off-chain the same way any real client would (quote first,
    // then commit to a hidden intent that matches that quote).
    const amountIn = ethers.parseUnits("1000", 18);
    const expectedOut = await pool.getAmountOut(amountIn, reserveA, reserveB);
    await tokenA.mint(agent.address, amountIn);
    await tokenA.connect(agent).approve(executorAddr, amountIn);

    const intentData = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256"],
      [await tokenA.getAddress(), amountIn, expectedOut]
    );
    const built = buildIntent(agent.address, intentData, 1);

    // Agent also bonds and commits — the hash is all anyone watching the
    // chain sees at this point. No token addresses, no amounts, nothing
    // about what's being swapped is visible yet.
    await contract.connect(agent).depositBond({ value: MIN_BOND });
    await contract.connect(agent).commitIntent(built.commitId, built.commitHash);

    // No swap has happened yet — the pool's price hasn't moved.
    expect(await pool.reserveA()).to.equal(reserveA);
    expect(await tokenB.balanceOf(agent.address)).to.equal(0n);

    const epoch = await contract.currentEpoch();
    await time.increaseTo(await contract.revealOpenTimeOf(epoch));

    // Reveal — this is the moment the intent's content becomes public AND
    // the real swap executes, in the same transaction, inside whatever
    // batch of other agents' reveals happened to land in this window.
    const tx = await contract.connect(agent).revealIntent(built.commitId, built.intentData, built.salt, executorAddr);
    await expect(tx).to.emit(contract, "IntentRevealed").withArgs(built.commitId, agent.address, executorAddr, ethers.ZeroAddress, true);
    await expect(tx).to.emit(executor, "IntentSwapExecuted").withArgs(agent.address, await tokenA.getAddress(), amountIn, expectedOut);
    await expect(tx).to.emit(pool, "Swap");

    // The whole point, verified independently: the agent's real balances
    // moved by exactly the AMM math said they would.
    expect(await tokenA.balanceOf(agent.address)).to.equal(0n);
    expect(await tokenB.balanceOf(agent.address)).to.equal(expectedOut);
    expect(await pool.reserveA()).to.equal(reserveA + amountIn);
    expect(await pool.reserveB()).to.equal(reserveB - expectedOut);

    const stored = await contract.commitments(built.commitId);
    expect(stored.revealed).to.equal(true);
  });
});
