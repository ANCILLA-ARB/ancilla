// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title AncillaSwapHook (Ancilla protocol — Option A architecture)
/// @notice Uniswap v4 hook that absorbs Ancilla's full commit-reveal
///         mechanism, gating access to a REAL v4 pool's liquidity instead
///         of a bespoke standalone AMM. This is the "hook absorbs
///         commit-reveal entirely" design discussed and chosen over the
///         alternative (a thin hook calling back into a separate,
///         unmodified `IntentCommitReveal`) — see the project's public
///         dossier for that discussion. `IntentCommitReveal.sol` is left
///         in the repo unmodified; this is a parallel, not a patch.
///
///         WHAT CHANGED FROM `IntentCommitReveal` + `SwapExecutor`:
///          - Bonding, epoch math, commit, and slashing are ported over
///            close to verbatim — same errors, same invariants, same
///            `lockedBond` fix (see IntentCommitReveal's "Third bug").
///          - `revealIntent` no longer exists as its own transaction.
///            Reveal and execution are now the SAME transaction: an agent
///            calls a v4 swap (through `AncillaHookRouter`) with the
///            reveal payload (commitId, intentData, salt) attached as
///            `hookData`. `_beforeSwap` verifies the hash, the timing
///            window, and — critically — that the swap actually being
///            submitted (token, direction, amount) matches what was
///            committed to, before allowing it to proceed against real
///            pool liquidity. `_afterSwap` enforces the committed
///            `minAmountOut` against the swap's real, executed output.
///          - EIP-712 relayed commit/reveal (Phase 3, partial, in
///            `IntentCommitReveal`) is NOT yet ported here — a known,
///            deliberately-flagged gap, not a silent omission.
///
///         WHAT DIDN'T CHANGE (same caveats as `IntentCommitReveal`):
///          - Does not hide anything from the Arbitrum sequencer.
///          - Not a ZK proof system — a hash commitment plus an economic
///            bond, same as before.
///          - Batching randomness is `block.timestamp` math, not a VRF.
///
///         EMERGENCY PAUSE: same shape as IntentCommitReveal's — `guardian`
///         can pause/unpause `commitIntent` only. `revealAndSwap` (via
///         `_beforeSwap`/`_afterSwap`) keeps working while paused, so an
///         agent with an already-locked bond and an already-submitted
///         commitment can always still resolve it. Single immutable
///         address for now, same documented MVP caveat as
///         IntentCommitReveal's.
///
///         ECONOMIC HARDENING: `slasherRewardBps` pays whoever calls
///         `slashNoReveal` a cut of the penalty instead of sending 100% to
///         `treasury` — same reasoning as IntentCommitReveal's identical
///         field: permissionless-but-unrewarded enforcement in practice
///         means nobody bothers. See IntentCommitReveal.sol's header for
///         the fuller writeup, including the flat-bond-vs-notional-value
///         limitation this does NOT fix.
contract AncillaSwapHook is BaseHook, Pausable {
    // ---------------------------------------------------------------------
    // Config — identical shape to IntentCommitReveal's constructor params.
    // ---------------------------------------------------------------------

    uint64 public immutable commitWindowSeconds;
    uint64 public immutable revealDelaySeconds;
    uint64 public immutable revealWindowSeconds;
    uint256 public immutable minBond;
    address public immutable treasury;
    address public immutable guardian;
    /// @notice Share of a slashed penalty (basis points out of 10,000)
    ///         paid to whoever calls `slashNoReveal` — same reasoning as
    ///         IntentCommitReveal's identical field.
    uint16 public immutable slasherRewardBps;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    struct Commitment {
        bytes32 commitHash;
        address agent;
        uint64 epoch;
        bool revealed;
        bool slashed;
    }

    /// @dev commitId => Commitment
    mapping(bytes32 => Commitment) public commitments;

    /// @dev bond balance per agent, deposited via depositBond().
    mapping(address => uint256) public bondBalance;

    /// @dev sum of `minBond` reserved against this agent's currently
    ///      unresolved commitments — same fix as IntentCommitReveal's
    ///      "Third bug" (bond could otherwise be withdrawn right after
    ///      committing, before ever being slashed).
    mapping(address => uint256) public lockedBond;

    event BondDeposited(address indexed agent, uint256 amount, uint256 newBalance);
    event BondWithdrawn(address indexed agent, uint256 amount, uint256 newBalance);
    event IntentCommitted(
        bytes32 indexed commitId, address indexed agent, uint64 epoch, uint64 revealOpenTime, uint64 revealCloseTime
    );
    /// @notice Emitted once per successfully revealed-and-executed intent.
    /// @param amountOut The real, executed output amount (post-swap),
    ///        not the pre-committed minimum — lets anyone verify the swap
    ///        actually cleared at or above what the agent required.
    event IntentSwapExecuted(
        bytes32 indexed commitId, address indexed agent, address tokenIn, uint256 amountIn, uint256 amountOut
    );
    event IntentSlashed(
        bytes32 indexed commitId, address indexed agent, uint256 totalPenalty, uint256 slasherReward, address slasher
    );

    error BondTooLow(uint256 have, uint256 need);
    error CommitAlreadyExists();
    error CommitNotFound();
    error AlreadyRevealed();
    error AlreadySlashed();
    error RevealNotOpenYet(uint64 opensAt);
    error RevealWindowClosed(uint64 closedAt);
    error HashMismatch();
    error StillInsideRevealWindow(uint64 closesAt);
    error InsufficientFreeBond();
    /// @notice `intentData`'s token isn't either currency of the pool this
    ///         swap targets.
    error IntentTokenNotInPool();
    /// @notice The swap's `zeroForOne` doesn't match which side of the pool
    ///         `intentData`'s tokenIn is actually on.
    error IntentDirectionMismatch();
    /// @notice The swap isn't exact-input, or its input amount doesn't
    ///         equal `intentData`'s committed `amountIn`.
    error IntentAmountMismatch();
    /// @notice The real, executed output fell below `intentData`'s
    ///         committed `minAmountOut`.
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error NotGuardian();

    constructor(
        IPoolManager _manager,
        uint64 _commitWindowSeconds,
        uint64 _revealDelaySeconds,
        uint64 _revealWindowSeconds,
        uint256 _minBond,
        address _treasury,
        address _guardian,
        uint16 _slasherRewardBps
    ) BaseHook(_manager) {
        require(_commitWindowSeconds > 0, "commitWindow=0");
        require(_revealWindowSeconds > 0, "revealWindow=0");
        require(_treasury != address(0), "treasury=0");
        require(_guardian != address(0), "guardian=0");
        require(_slasherRewardBps <= 10_000, "slasherRewardBps>100%");
        commitWindowSeconds = _commitWindowSeconds;
        revealDelaySeconds = _revealDelaySeconds;
        revealWindowSeconds = _revealWindowSeconds;
        minBond = _minBond;
        treasury = _treasury;
        guardian = _guardian;
        slasherRewardBps = _slasherRewardBps;
    }

    function pause() external {
        if (msg.sender != guardian) revert NotGuardian();
        _pause();
    }

    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian();
        _unpause();
    }

    /// @notice Only `beforeSwap` and `afterSwap` are used — deliberately
    ///         minimal, same reasoning as `AncillaTreasuryMultisig`'s
    ///         narrow scope: fewer active hook points is less to get wrong
    ///         and less for `HookMiner` to have to satisfy.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------
    // Bonding — identical to IntentCommitReveal.
    // ---------------------------------------------------------------------

    function depositBond() external payable {
        bondBalance[msg.sender] += msg.value;
        emit BondDeposited(msg.sender, msg.value, bondBalance[msg.sender]);
    }

    function withdrawBond(uint256 amount) external {
        uint256 bal = bondBalance[msg.sender];
        if (bal < amount) revert InsufficientFreeBond();
        uint256 remaining = bal - amount;
        if (remaining < lockedBond[msg.sender]) revert InsufficientFreeBond();
        if (remaining < minBond && remaining != 0) revert InsufficientFreeBond();
        bondBalance[msg.sender] = remaining;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "withdraw transfer failed");
        emit BondWithdrawn(msg.sender, amount, remaining);
    }

    // ---------------------------------------------------------------------
    // Epoch math — identical to IntentCommitReveal.
    // ---------------------------------------------------------------------

    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp) / commitWindowSeconds;
    }

    function revealOpenTimeOf(uint64 epoch) public view returns (uint64) {
        return (epoch + 1) * commitWindowSeconds + revealDelaySeconds;
    }

    function revealCloseTimeOf(uint64 epoch) public view returns (uint64) {
        return revealOpenTimeOf(epoch) + revealWindowSeconds;
    }

    // ---------------------------------------------------------------------
    // Commit — identical to IntentCommitReveal.commitIntent (no relay path
    // yet — see header).
    // ---------------------------------------------------------------------

    /// @param commitId   caller-chosen unique id.
    /// @param commitHash keccak256(abi.encode(intentData, salt, msg.sender))
    ///        where intentData is abi.encode(tokenIn, amountIn, minAmountOut).
    function commitIntent(bytes32 commitId, bytes32 commitHash) external whenNotPaused {
        uint256 needed = lockedBond[msg.sender] + minBond;
        if (bondBalance[msg.sender] < needed) revert BondTooLow(bondBalance[msg.sender], needed);
        if (commitments[commitId].agent != address(0)) revert CommitAlreadyExists();

        lockedBond[msg.sender] += minBond;

        uint64 epoch = currentEpoch();
        commitments[commitId] =
            Commitment({commitHash: commitHash, agent: msg.sender, epoch: epoch, revealed: false, slashed: false});

        emit IntentCommitted(commitId, msg.sender, epoch, revealOpenTimeOf(epoch), revealCloseTimeOf(epoch));
    }

    // ---------------------------------------------------------------------
    // Slashing — identical to IntentCommitReveal.slashNoReveal.
    // ---------------------------------------------------------------------

    function slashNoReveal(bytes32 commitId) external {
        Commitment storage c = commitments[commitId];
        if (c.agent == address(0)) revert CommitNotFound();
        if (c.revealed) revert AlreadyRevealed();
        if (c.slashed) revert AlreadySlashed();

        uint64 closeTime = revealCloseTimeOf(c.epoch);
        if (block.timestamp < closeTime) revert StillInsideRevealWindow(closeTime);

        c.slashed = true;
        lockedBond[c.agent] -= minBond;

        uint256 penalty = minBond;
        uint256 bal = bondBalance[c.agent];
        if (penalty > bal) penalty = bal;
        bondBalance[c.agent] = bal - penalty;

        uint256 reward = (penalty * slasherRewardBps) / 10_000;
        uint256 toTreasury = penalty - reward;

        if (toTreasury > 0) {
            (bool okTreasury,) = treasury.call{value: toTreasury}("");
            require(okTreasury, "slash transfer failed");
        }
        if (reward > 0) {
            (bool okReward,) = msg.sender.call{value: reward}("");
            require(okReward, "slasher reward transfer failed");
        }

        emit IntentSlashed(commitId, c.agent, penalty, reward, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Reveal-as-swap — the actual v4 hook logic. Called only by
    // PoolManager (enforced by BaseHook's `onlyPoolManager` on the public
    // wrappers), only ever reached via AncillaHookRouter.revealAndSwap in
    // this repo, which is the only caller that constructs `hookData`.
    // ---------------------------------------------------------------------

    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        (bytes32 commitId, bytes memory intentData, bytes32 salt, address agent) =
            abi.decode(hookData, (bytes32, bytes, bytes32, address));

        Commitment storage c = commitments[commitId];
        if (c.agent == address(0)) revert CommitNotFound();
        if (c.agent != agent) revert CommitNotFound();
        if (c.revealed) revert AlreadyRevealed();
        if (c.slashed) revert AlreadySlashed();

        uint64 openTime = revealOpenTimeOf(c.epoch);
        uint64 closeTime = revealCloseTimeOf(c.epoch);
        if (block.timestamp < openTime) revert RevealNotOpenYet(openTime);
        if (block.timestamp >= closeTime) revert RevealWindowClosed(closeTime);

        bytes32 expected = keccak256(abi.encode(intentData, salt, agent));
        if (expected != c.commitHash) revert HashMismatch();

        (address tokenIn, uint256 amountIn,) = abi.decode(intentData, (address, uint256, uint256));
        _validateSwapMatchesIntent(key, params, tokenIn, amountIn);

        c.revealed = true;
        lockedBond[agent] -= minBond;

        return (BaseHook.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata,
        BalanceDelta delta,
        bytes calldata hookData
    ) internal override returns (bytes4, int128) {
        (bytes32 commitId, bytes memory intentData,, address agent) =
            abi.decode(hookData, (bytes32, bytes, bytes32, address));
        (address tokenIn, uint256 amountIn, uint256 minAmountOut) =
            abi.decode(intentData, (address, uint256, uint256));

        bool tokenInIsCurrency0 = tokenIn == Currency.unwrap(key.currency0);
        int128 rawOut = tokenInIsCurrency0 ? delta.amount1() : delta.amount0();
        // Positive delta = owed to the caller = the real output amount.
        uint256 amountOut = rawOut > 0 ? uint256(uint128(rawOut)) : 0;
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        emit IntentSwapExecuted(commitId, agent, tokenIn, amountIn, amountOut);

        return (BaseHook.afterSwap.selector, 0);
    }

    /// @dev Cross-checks the swap actually being submitted right now
    ///      against the revealed intentData, so a valid hash commitment
    ///      can't be reused to ride along with a different token, a
    ///      different direction, or a different amount than what the
    ///      agent actually committed to.
    function _validateSwapMatchesIntent(PoolKey calldata key, SwapParams calldata params, address tokenIn, uint256 amountIn)
        private
        pure
    {
        bool tokenInIsCurrency0 = tokenIn == Currency.unwrap(key.currency0);
        bool tokenInIsCurrency1 = tokenIn == Currency.unwrap(key.currency1);
        if (!tokenInIsCurrency0 && !tokenInIsCurrency1) revert IntentTokenNotInPool();
        if (params.zeroForOne != tokenInIsCurrency0) revert IntentDirectionMismatch();
        // Exact-input only: amountSpecified must be negative and match
        // amountIn exactly (same "exact-in, with a minAmountOut floor"
        // shape as SwapExecutor/AncillaSwapPool today).
        if (params.amountSpecified != -int256(amountIn)) revert IntentAmountMismatch();
    }
}
