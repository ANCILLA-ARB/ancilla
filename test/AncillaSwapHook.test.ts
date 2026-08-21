import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { buildIntent } from "../sdk/intent";
import { mineHookAddress, HookFlags } from "../scripts/lib/hookMiner";

// Verified from @uniswap/v4-core/src/libraries/TickMath.sol — the standard
// "no real limit" sentinel values used throughout the v4 ecosystem: one tick
// inside each absolute bound, since the bound itself is excluded.
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

/**
 * Tests for AncillaSwapHook + AncillaHookRouter — the "Option A" v4
 * architecture: a Uniswap v4 hook that absorbs Ancilla's full commit-reveal
 * mechanism, gating access to a REAL v4 pool instead of the standalone
 * AncillaSwapPool. `IntentCommitReveal`/`AncillaSwapPool`/`SwapExecutor`
 * are untouched by this file and keep their own full test suite.
 *
 * Fixture deploys a real Uniswap v4 PoolManager locally (from
 * @uniswap/v4-core), mines a CREATE2 salt so the hook address encodes
 * exactly {beforeSwap, afterSwap} in its low bits, deploys it through
 * Create2Factory, initializes a real pool with it, and seeds real
 * concentrated-liquidity via Uniswap's own PoolModifyLiquidityTest test
 * utility (dev/test tooling only — see AncillaHookRouter's header comment
 * for why the actual agent-facing swap path deliberately does NOT depend
 * on Uniswap's UNLICENSED test routers).
 */

const COMMIT_WINDOW = 300;
const REVEAL_DELAY = 60;
const REVEAL_WINDOW = 300;
const MIN_BOND = ethers.parseEther("0.1");
const FEE = 3000; // 0.3%, matches AncillaSwapPool's fee for an apples-to-apples comparison
const TICK_SPACING = 60;
const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2^96 — the standard "1:1 price" constant used throughout Uniswap v3/v4

async function deployHookStack() {
  const [deployer, agent, treasury, guardian] = await ethers.getSigners();

  const PoolManager = await ethers.getContractFactory("PoolManager");
  const poolManager = await PoolManager.deploy(deployer.address);
  await poolManager.waitForDeployment();
  const poolManagerAddress = await poolManager.getAddress();

  const Create2Factory = await ethers.getContractFactory("Create2Factory");
  const factory = await Create2Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();

  const Token = await ethers.getContractFactory("TestToken");
  const tokenX = await Token.deploy("Ancilla Test X", "aX");
  await tokenX.waitForDeployment();
  const tokenY = await Token.deploy("Ancilla Test Y", "aY");
  await tokenY.waitForDeployment();

  // Sort by address so currency0 < currency1, as v4 requires.
  const [addrX, addrY] = [await tokenX.getAddress(), await tokenY.getAddress()];
  const [token0, token1, currency0, currency1] =
    BigInt(addrX) < BigInt(addrY) ? [tokenX, tokenY, addrX, addrY] : [tokenY, tokenX, addrY, addrX];

  // Mine a CREATE2 salt that gives AncillaSwapHook an address whose low
  // bits encode exactly {beforeSwap, afterSwap}.
  const HookFactory = await ethers.getContractFactory("AncillaSwapHook");
  const constructorArgsEncoded = HookFactory.interface.encodeDeploy([
    poolManagerAddress,
    COMMIT_WINDOW,
    REVEAL_DELAY,
    REVEAL_WINDOW,
    MIN_BOND,
    treasury.address,
    guardian.address,
  ]);
  const creationCode = HookFactory.bytecode;
  const flags = HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP;
  const mined = mineHookAddress(factoryAddress, flags, creationCode, constructorArgsEncoded);

  const deployTx = await factory.deploy(mined.salt, mined.initCode);
  await deployTx.wait();
  const hook = await ethers.getContractAt("AncillaSwapHook", mined.address);
  // Sanity: the contract really did land where we predicted, and BaseHook's
  // own constructor-time validateHookAddress() didn't revert (it would
  // have reverted the deploy tx entirely if the mined address were wrong).
  expect(await ethers.provider.getCode(mined.address)).to.not.equal("0x");

  const Router = await ethers.getContractFactory("AncillaHookRouter");
  const router = await Router.deploy(poolManagerAddress);
  await router.waitForDeployment();

  const key = {
    currency0,
    currency1,
    fee: FEE,
    tickSpacing: TICK_SPACING,
    hooks: mined.address,
  };
  await (await poolManager.initialize(key, SQRT_PRICE_1_1)).wait();

  // Seed real liquidity via Uniswap's own test utility (dev/test tooling
  // only — see AncillaHookRouter.sol's header comment).
  const MathHelper = await ethers.getContractFactory("V4TestMath");
  const mathHelper = await MathHelper.deploy();
  await mathHelper.waitForDeployment();
  const tickLower = await mathHelper.minUsableTick(TICK_SPACING);
  const tickUpper = await mathHelper.maxUsableTick(TICK_SPACING);
  const sqrtPriceA = await mathHelper.getSqrtPriceAtTick(tickLower);
  const sqrtPriceB = await mathHelper.getSqrtPriceAtTick(tickUpper);

  const seedAmount = ethers.parseUnits("100000", 18);
  const liquidity = await mathHelper.getLiquidityForAmounts(
    SQRT_PRICE_1_1,
    sqrtPriceA,
    sqrtPriceB,
    seedAmount,
    seedAmount
  );

  const LiquidityRouter = await ethers.getContractFactory("AncillaLiquidityRouter");
  const liquidityRouter = await LiquidityRouter.deploy(poolManagerAddress);
  await liquidityRouter.waitForDeployment();
  const liquidityRouterAddress = await liquidityRouter.getAddress();

  await (await token0.mint(deployer.address, seedAmount)).wait();
  await (await token1.mint(deployer.address, seedAmount)).wait();
  await (await token0.connect(deployer).approve(liquidityRouterAddress, seedAmount)).wait();
  await (await token1.connect(deployer).approve(liquidityRouterAddress, seedAmount)).wait();

  await (
    await liquidityRouter
      .connect(deployer)
      .addLiquidity(key, { tickLower, tickUpper, liquidityDelta: liquidity, salt: ethers.ZeroHash })
  ).wait();

  return {
    deployer,
    agent,
    treasury,
    guardian,
    poolManager,
    hook,
    router,
    token0,
    token1,
    currency0,
    currency1,
    key,
  };
}

/** tokenIn's intentData shape is identical to SwapExecutor's:
 *  abi.encode(address tokenIn, uint256 amountIn, uint256 minAmountOut). */
function encodeIntentData(tokenIn: string, amountIn: bigint, minAmountOut: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "uint256"],
    [tokenIn, amountIn, minAmountOut]
  );
}

/**
 * Uniswap v4's `Hooks.callHook` catches a reverting hook call and re-throws
 * it wrapped in an ERC-7751 `WrappedError(address target, bytes4 selector,
 * bytes reason, bytes details)` (see @uniswap/v4-core's CustomRevert.sol) —
 * so a straightforward `revertedWithCustomError(hook, "X")` never matches;
 * the hook's actual error is nested inside `reason`. This unwraps it.
 * `hardhat-chai-matchers@2.1.2` (the version this repo uses) has no
 * built-in support for this ERC-7751 nesting, hence the manual decode.
 */
const wrappedErrorInterface = new ethers.Interface([
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);

async function expectHookRevert(call: Promise<unknown>, hookInterface: any, errorName: string) {
  try {
    await call;
  } catch (err: any) {
    const data: string | undefined = err?.data ?? err?.error?.data ?? err?.info?.error?.data;
    if (!data) throw err; // some other failure shape — surface it as-is, don't mask it
    let reasonBytes: string;
    try {
      const decoded = wrappedErrorInterface.parseError(data);
      reasonBytes = decoded!.args.reason as string;
    } catch {
      reasonBytes = data; // not wrapped after all — try decoding directly
    }
    const inner = hookInterface.parseError(reasonBytes);
    expect(inner?.name, `expected ${errorName}, got raw revert data ${data}`).to.equal(errorName);
    return;
  }
  expect.fail(`expected a revert (${errorName}), but the call succeeded`);
}

/** Mints tokenIn to the agent, approves the router, bonds, commits, and
 *  returns everything a test needs to then call revealAndSwap (or
 *  deliberately corrupt one field first to prove a rejection). Does NOT
 *  advance time — most tests need to control that themselves. Module-scope
 *  (not inside a describe block) so both "reveal-as-swap" and "slashing"
 *  below can use it. */
async function commitSwap(
  fixture: Awaited<ReturnType<typeof deployHookStack>>,
  opts: { tokenIn: "token0" | "token1"; amountIn: bigint; minAmountOut: bigint; nonce: number }
) {
  const { hook, router, agent, token0, token1, currency0, currency1 } = fixture;
  const tokenIn = opts.tokenIn === "token0" ? token0 : token1;
  const tokenInAddr = opts.tokenIn === "token0" ? currency0 : currency1;

  await (await tokenIn.mint(agent.address, opts.amountIn)).wait();
  await (await tokenIn.connect(agent).approve(await router.getAddress(), opts.amountIn)).wait();
  await (await hook.connect(agent).depositBond({ value: MIN_BOND })).wait();

  const intentData = encodeIntentData(tokenInAddr, opts.amountIn, opts.minAmountOut);
  const built = buildIntent(agent.address, intentData, opts.nonce);
  await (await hook.connect(agent).commitIntent(built.commitId, built.commitHash)).wait();

  const commitment = await hook.commitments(built.commitId);
  return {
    built,
    intentData,
    tokenInAddr,
    openTime: await hook.revealOpenTimeOf(commitment.epoch),
    closeTime: await hook.revealCloseTimeOf(commitment.epoch),
  };
}

describe("AncillaSwapHook + AncillaHookRouter (Option A: hook absorbs commit-reveal)", function () {
  describe("deployment", function () {
    it("mines a hook address whose low bits encode exactly {beforeSwap, afterSwap}", async function () {
      const { hook } = await loadFixture(deployHookStack);
      const addr = BigInt(await hook.getAddress());
      const ALL_HOOK_MASK = (1n << 14n) - 1n;
      const flags = addr & ALL_HOOK_MASK;
      expect(flags).to.equal(HookFlags.BEFORE_SWAP | HookFlags.AFTER_SWAP);
    });

    it("rejects a zero commitWindow / zero revealWindow / zero treasury / zero guardian, same as IntentCommitReveal", async function () {
      const [deployer] = await ethers.getSigners();
      const PoolManager = await ethers.getContractFactory("PoolManager");
      const poolManager = await PoolManager.deploy(deployer.address);
      await poolManager.waitForDeployment();
      const Hook = await ethers.getContractFactory("AncillaSwapHook");
      // These all revert before BaseHook's address-validation even runs
      // (require() checks are first in the constructor body), so no
      // CREATE2 mining is needed to prove the rejection.
      await expect(
        Hook.deploy(await poolManager.getAddress(), 0, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, deployer.address, deployer.address)
      ).to.be.reverted;
      await expect(
        Hook.deploy(await poolManager.getAddress(), COMMIT_WINDOW, REVEAL_DELAY, 0, MIN_BOND, deployer.address, deployer.address)
      ).to.be.reverted;
      await expect(
        Hook.deploy(await poolManager.getAddress(), COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, ethers.ZeroAddress, deployer.address)
      ).to.be.reverted;
      await expect(
        Hook.deploy(await poolManager.getAddress(), COMMIT_WINDOW, REVEAL_DELAY, REVEAL_WINDOW, MIN_BOND, deployer.address, ethers.ZeroAddress)
      ).to.be.reverted;
    });
  });

  describe("commit + bond (ported from IntentCommitReveal)", function () {
    it("requires sufficient bond before allowing a commit", async function () {
      const { hook, agent } = await loadFixture(deployHookStack);
      const built = buildIntent(agent.address, encodeIntentData(ethers.ZeroAddress, 1n, 0n), 1);
      await expect(hook.connect(agent).commitIntent(built.commitId, built.commitHash)).to.be.revertedWithCustomError(
        hook,
        "BondTooLow"
      );
    });

    it("accepts a commit once bonded, and locks the bond", async function () {
      const { hook, agent } = await loadFixture(deployHookStack);
      await (await hook.connect(agent).depositBond({ value: MIN_BOND })).wait();
      const built = buildIntent(agent.address, encodeIntentData(ethers.ZeroAddress, 1n, 0n), 1);
      await expect(hook.connect(agent).commitIntent(built.commitId, built.commitHash)).to.emit(hook, "IntentCommitted");
      expect(await hook.lockedBond(agent.address)).to.equal(MIN_BOND);
    });

    it("blocks withdrawing bond that's locked against a pending commitment", async function () {
      const { hook, agent } = await loadFixture(deployHookStack);
      await (await hook.connect(agent).depositBond({ value: MIN_BOND })).wait();
      const built = buildIntent(agent.address, encodeIntentData(ethers.ZeroAddress, 1n, 0n), 1);
      await (await hook.connect(agent).commitIntent(built.commitId, built.commitHash)).wait();
      await expect(hook.connect(agent).withdrawBond(MIN_BOND)).to.be.revertedWithCustomError(
        hook,
        "InsufficientFreeBond"
      );
    });

    it("lets an agent withdraw free (unlocked) bond back out", async function () {
      const { hook, agent } = await loadFixture(deployHookStack);
      await (await hook.connect(agent).depositBond({ value: MIN_BOND })).wait();
      await expect(hook.connect(agent).withdrawBond(MIN_BOND))
        .to.emit(hook, "BondWithdrawn")
        .withArgs(agent.address, MIN_BOND, 0n);
      expect(await hook.bondBalance(agent.address)).to.equal(0n);
    });

    it("reverts (doesn't silently no-op) if the bond withdrawal's ETH transfer itself fails", async function () {
      const { hook } = await loadFixture(deployHookStack);
      const Rejecting = await ethers.getContractFactory("RejectingReceiver");
      const rejecting = await Rejecting.deploy(await hook.getAddress());
      await rejecting.waitForDeployment();

      await (await rejecting.deposit({ value: MIN_BOND })).wait();
      await expect(rejecting.tryWithdraw(MIN_BOND)).to.be.reverted;
      // Balance accounting must be untouched by the failed attempt.
      expect(await hook.bondBalance(await rejecting.getAddress())).to.equal(MIN_BOND);
    });
  });

  describe("emergency pause (ported from IntentCommitReveal)", function () {
    it("lets the guardian pause and unpause", async function () {
      const { hook, guardian } = await loadFixture(deployHookStack);
      expect(await hook.paused()).to.equal(false);
      await expect(hook.connect(guardian).pause()).to.emit(hook, "Paused").withArgs(guardian.address);
      expect(await hook.paused()).to.equal(true);
      await expect(hook.connect(guardian).unpause()).to.emit(hook, "Unpaused").withArgs(guardian.address);
      expect(await hook.paused()).to.equal(false);
    });

    it("rejects pause/unpause from anyone but the guardian", async function () {
      const { hook, agent } = await loadFixture(deployHookStack);
      await expect(hook.connect(agent).pause()).to.be.revertedWithCustomError(hook, "NotGuardian");
      await expect(hook.connect(agent).unpause()).to.be.revertedWithCustomError(hook, "NotGuardian");
    });

    it("blocks new commits while paused, but never blocks resolving an already-committed reveal-and-swap", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, guardian, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });

      await hook.connect(guardian).pause();

      // A brand new commit: blocked.
      await expect(hook.connect(agent).commitIntent(ethers.ZeroHash, ethers.ZeroHash)).to.be.revertedWithCustomError(
        hook,
        "EnforcedPause"
      );

      // Resolving the commitment made before the pause: NOT blocked, even
      // while still paused.
      await time.increaseTo(openTime);
      expect(await hook.paused()).to.equal(true);
      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expect(router.connect(agent).revealAndSwap(key, params, built.commitId, intentData, built.salt)).to.emit(
        hook,
        "IntentSwapExecuted"
      );
    });
  });

  describe("reveal-as-swap (the actual hook logic)", function () {
    it("commits, waits for the batch window, then reveal-and-swap executes a real v4 swap with the exact committed amount", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, token1, key } = fixture;
      const amountIn = ethers.parseUnits("1000", 18);

      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      const tokenOutBalBefore: bigint = await token1.balanceOf(agent.address);

      await expect(router.connect(agent).revealAndSwap(key, params, built.commitId, intentData, built.salt))
        .to.emit(hook, "IntentSwapExecuted")
        .withArgs(built.commitId, agent.address, fixture.currency0, amountIn, anyValue);

      expect(await token1.balanceOf(agent.address)).to.be.greaterThan(tokenOutBalBefore);
      expect((await hook.commitments(built.commitId)).revealed).to.equal(true);
      expect(await hook.lockedBond(agent.address)).to.equal(0n);
    });

    it("swaps the other direction too (token1 -> token0), not just the one direction every other test happens to exercise", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, token0, key } = fixture;
      const amountIn = ethers.parseUnits("500", 18);

      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token1",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      const params = { zeroForOne: false, amountSpecified: -amountIn, sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n };
      const tokenOutBalBefore: bigint = await token0.balanceOf(agent.address);

      await router.connect(agent).revealAndSwap(key, params, built.commitId, intentData, built.salt);

      expect(await token0.balanceOf(agent.address)).to.be.greaterThan(tokenOutBalBefore);
    });

    it("rejects revealing before the reveal window opens", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData } = await commitSwap(fixture, { tokenIn: "token0", amountIn, minAmountOut: 1n, nonce: 1 });

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "RevealNotOpenYet"
      );
    });

    it("rejects revealing after the reveal window has closed", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData, closeTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(closeTime);

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "RevealWindowClosed"
      );
    });

    it("rejects a reveal whose intentData/salt don't hash to the original commitment", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, openTime } = await commitSwap(fixture, { tokenIn: "token0", amountIn, minAmountOut: 1n, nonce: 1 });
      await time.increaseTo(openTime);

      const tamperedIntentData = encodeIntentData(fixture.currency0, amountIn + 1n, 1n); // one wei off from what was committed
      const params = { zeroForOne: true, amountSpecified: -(amountIn + 1n), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, tamperedIntentData, built.salt),
        hook.interface,
        "HashMismatch"
      );
    });

    it("rejects a swap whose token isn't part of the intent (real intentData, wrong swap params)", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      // Committed to token0->token1 (zeroForOne: true), but submits the swap
      // in the opposite direction — same amount, wrong side.
      const params = { zeroForOne: false, amountSpecified: -amountIn, sqrtPriceLimitX96: MAX_SQRT_PRICE - 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "IntentDirectionMismatch"
      );
    });

    it("rejects a swap whose committed tokenIn isn't part of the pool at all", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      // A syntactically valid address that is neither currency0 nor
      // currency1 of this pool.
      const foreignToken = ethers.Wallet.createRandom().address;
      const intentData = encodeIntentData(foreignToken, amountIn, 1n);
      const built = buildIntent(agent.address, intentData, 1);

      await (await hook.connect(agent).depositBond({ value: MIN_BOND })).wait();
      await (await hook.connect(agent).commitIntent(built.commitId, built.commitHash)).wait();
      const commitment = await hook.commitments(built.commitId);
      await time.increaseTo(await hook.revealOpenTimeOf(commitment.epoch));

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "IntentTokenNotInPool"
      );
    });

    it("rejects a swap amount that doesn't match what was committed", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      const params = { zeroForOne: true, amountSpecified: -(amountIn / 2n), sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "IntentAmountMismatch"
      );
    });

    it("rejects when the real, executed output falls below the committed minAmountOut", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      // Absurdly high floor — no real swap against this pool clears it.
      const unreachableMinOut = ethers.parseUnits("100000000", 18);
      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: unreachableMinOut,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "SlippageExceeded"
      );
    });

    it("rejects revealing the same commitment twice", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, router, agent, key } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, intentData, openTime } = await commitSwap(fixture, {
        tokenIn: "token0",
        amountIn,
        minAmountOut: 1n,
        nonce: 1,
      });
      await time.increaseTo(openTime);

      const params = { zeroForOne: true, amountSpecified: -amountIn, sqrtPriceLimitX96: MIN_SQRT_PRICE + 1n };
      await (await router.connect(agent).revealAndSwap(key, params, built.commitId, intentData, built.salt)).wait();

      await expectHookRevert(
        router.connect(agent).revealAndSwap.staticCall(key, params, built.commitId, intentData, built.salt),
        hook.interface,
        "AlreadyRevealed"
      );
    });
  });

  describe("slashing (ported from IntentCommitReveal)", function () {
    it("slashes a commitment that was never revealed once the reveal window closes", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook, agent, treasury } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built, closeTime } = await commitSwap(fixture, { tokenIn: "token0", amountIn, minAmountOut: 1n, nonce: 1 });
      await time.increaseTo(closeTime);

      const treasuryBalBefore = await ethers.provider.getBalance(treasury.address);
      await expect(hook.slashNoReveal(built.commitId))
        .to.emit(hook, "IntentSlashed")
        .withArgs(built.commitId, agent.address, MIN_BOND);
      const treasuryBalAfter = await ethers.provider.getBalance(treasury.address);

      expect(treasuryBalAfter - treasuryBalBefore).to.equal(MIN_BOND);
      expect(await hook.lockedBond(agent.address)).to.equal(0n);
    });

    it("rejects slashing while the reveal window is still open", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { hook } = fixture;
      const amountIn = ethers.parseUnits("100", 18);
      const { built } = await commitSwap(fixture, { tokenIn: "token0", amountIn, minAmountOut: 1n, nonce: 1 });

      await expect(hook.slashNoReveal(built.commitId)).to.be.revertedWithCustomError(hook, "StillInsideRevealWindow");
    });
  });

  describe("Create2Factory", function () {
    it("computeAddress predicts exactly where deploy() will actually put the contract", async function () {
      const [deployer] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory("Create2Factory");
      const factory = await Factory.deploy();
      await factory.waitForDeployment();

      const Token = await ethers.getContractFactory("TestToken");
      const bytecode = ethers.concat([
        Token.bytecode,
        Token.interface.encodeDeploy(["Predicted Token", "PRED"]),
      ]);
      const salt = ethers.zeroPadValue("0x01", 32);

      const predicted = await factory.computeAddress(salt, bytecode);
      const tx = await factory.deploy(salt, bytecode);
      const receipt = await tx.wait();
      const deployedEvent = receipt!.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e?.name === "Deployed");

      expect(deployedEvent?.args.addr).to.equal(predicted);
      expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
    });
  });

  describe("AncillaLiquidityRouter", function () {
    it("rejects a non-positive liquidityDelta (this router only ever adds)", async function () {
      const fixture = await loadFixture(deployHookStack);
      const { key } = fixture;
      const [deployer] = await ethers.getSigners();
      const Router = await ethers.getContractFactory("AncillaLiquidityRouter");
      // A second instance, pointed at the same PoolManager — doesn't need
      // to be the one the fixture already seeded liquidity through.
      const poolManagerAddress = await fixture.poolManager.getAddress();
      const liquidityRouter = await Router.deploy(poolManagerAddress);
      await liquidityRouter.waitForDeployment();

      await expect(
        liquidityRouter
          .connect(deployer)
          .addLiquidity(key, { tickLower: -60, tickUpper: 60, liquidityDelta: 0n, salt: ethers.ZeroHash })
      ).to.be.revertedWithCustomError(liquidityRouter, "OnlyAdding");
    });
  });
});
