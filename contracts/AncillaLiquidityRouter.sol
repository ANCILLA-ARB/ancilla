// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";

/// @title AncillaLiquidityRouter
/// @notice Minimal operator tooling for seeding/withdrawing liquidity in an
///         AncillaSwapHook-gated v4 pool, so demos and deployment scripts
///         don't depend on Uniswap's own `PoolModifyLiquidityTest` (a test
///         utility, `UNLICENSED`, not something to rely on outside a local
///         Hardhat run) — same reasoning as `AncillaHookRouter` not
///         depending on `PoolSwapTest`. Only handles ADDING liquidity
///         (always settles both currencies, never takes); this repo has no
///         need to remove liquidity from a demo pool.
contract AncillaLiquidityRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    error NotPoolManager();
    error OnlyAdding();

    struct CallbackData {
        address payer;
        PoolKey key;
        ModifyLiquidityParams params;
    }

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// @notice Adds liquidity to `key`'s pool. `msg.sender` must have
    ///         approved this router for however much of each currency the
    ///         given `params.liquidityDelta` actually costs (computable
    ///         off-chain via LiquidityAmounts, same as any v4 LP flow).
    function addLiquidity(PoolKey calldata key, ModifyLiquidityParams calldata params)
        external
        returns (BalanceDelta delta)
    {
        if (params.liquidityDelta <= 0) revert OnlyAdding();
        bytes memory result = poolManager.unlock(abi.encode(CallbackData(msg.sender, key, params)));
        delta = abi.decode(result, (BalanceDelta));
    }

    function unlockCallback(bytes calldata rawData) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory data = abi.decode(rawData, (CallbackData));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(data.key, data.params, "");

        int128 amount0 = delta.amount0();
        int128 amount1 = delta.amount1();
        // Adding liquidity always costs the payer on both sides (or is
        // zero on one side at the extremes of the range) — never credits.
        if (amount0 < 0) _settle(data.key.currency0, data.payer, uint256(uint128(-amount0)));
        if (amount1 < 0) _settle(data.key.currency1, data.payer, uint256(uint128(-amount1)));

        return abi.encode(delta);
    }

    function _settle(Currency currency, address payer, uint256 amount) private {
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }
}
