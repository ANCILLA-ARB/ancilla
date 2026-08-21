// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @title AncillaHookRouter
/// @notice The only supported entrypoint agents use to reveal-and-swap
///         through `AncillaSwapHook`. Uniswap v4's `PoolManager.swap()` can
///         only be called from inside an `unlock()` callback (flash
///         accounting), so this router exists to do that dance — call
///         `unlock`, receive the `unlockCallback`, call `swap`, then settle
///         whatever the agent owes the pool and take whatever the pool owes
///         the agent — on the agent's behalf.
///
///         Deliberately NOT built on Uniswap's own `PoolSwapTest` (a test
///         utility, `UNLICENSED`, not intended for anything resembling
///         production use) or `v4-periphery`'s `V4Router` (pinned to an
///         exact `pragma solidity 0.8.26`, one compiler version ahead of
///         every other contract in this repo). Writing this router
///         ourselves — small, MIT, 0.8.24, fully tested — keeps it
///         consistent with the rest of the repo's "minimal, self-authored,
///         directly reasoned about" contracts, same as
///         `AncillaTreasuryMultisig`.
///
///         Security note: the true agent identity comes from THIS
///         contract's own `msg.sender` on `revealAndSwap` — never from
///         caller-supplied `hookData`. `AncillaSwapHook` trusts the agent
///         address embedded in `hookData` precisely because this router is
///         the only thing that ever constructs it, and it always embeds
///         its own real caller, never an arbitrary address. Anyone can
///         still only successfully reveal a commitment they know the
///         correct `intentData`/`salt` for — same hash-commitment
///         guarantee as `IntentCommitReveal`.
contract AncillaHookRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    error NotPoolManager();

    struct CallbackData {
        address agent;
        PoolKey key;
        SwapParams params;
        bytes hookData;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// @notice Reveals a previously committed intent and executes the real
    ///         swap in the same transaction. `msg.sender` must have
    ///         approved this router for `amountIn` of the token it's
    ///         swapping — same "approve the router" pattern SwapExecutor
    ///         uses today.
    /// @param key         the v4 pool to swap against.
    /// @param params      the actual swap parameters — checked by the hook
    ///                    against `intentData`, so these can't diverge from
    ///                    what was originally committed to.
    /// @param commitId    id used at commit time.
    /// @param intentData  abi.encode(tokenIn, amountIn, minAmountOut) —
    ///                    same shape SwapExecutor's intentData already uses.
    /// @param salt        the salt used to build the original commitHash.
    function revealAndSwap(
        PoolKey calldata key,
        SwapParams calldata params,
        bytes32 commitId,
        bytes calldata intentData,
        bytes32 salt
    ) external returns (BalanceDelta delta) {
        bytes memory hookData = abi.encode(commitId, intentData, salt, msg.sender);
        bytes memory result = poolManager.unlock(abi.encode(CallbackData(msg.sender, key, params, hookData)));
        delta = abi.decode(result, (BalanceDelta));
    }

    /// @dev Called back by PoolManager from inside `unlock()`. Not
    ///      externally useful on its own — `onlyPoolManager`-equivalent
    ///      guard below.
    function unlockCallback(bytes calldata rawData) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory data = abi.decode(rawData, (CallbackData));

        BalanceDelta delta = poolManager.swap(data.key, data.params, data.hookData);

        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();

        // Negative = this router (on the agent's behalf) owes the pool;
        // positive = the pool owes the agent. Same convention documented
        // on IHooks.afterSwap and used throughout v4.
        if (amount0 < 0) _settle(data.key.currency0, data.agent, uint256(uint128(-amount0)));
        if (amount1 < 0) _settle(data.key.currency1, data.agent, uint256(uint128(-amount1)));
        if (amount0 > 0) poolManager.take(data.key.currency0, data.agent, uint256(uint128(amount0)));
        if (amount1 > 0) poolManager.take(data.key.currency1, data.agent, uint256(uint128(amount1)));

        return abi.encode(delta);
    }

    /// @dev Standard v4 ERC20 settlement: snapshot the manager's balance
    ///      (`sync`), pay in from the agent directly to the manager, then
    ///      `settle()` to reconcile the snapshot against the new balance.
    function _settle(Currency currency, address payer, uint256 amount) private {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }
}
