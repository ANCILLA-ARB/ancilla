// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @notice Test-only wrapper exposing a handful of Uniswap v4's internal
///         pure math helpers (tick bounds, sqrt price, liquidity-from-
///         amounts) as external view functions, so test/deploy scripts can
///         call them over RPC to seed pool liquidity correctly instead of
///         hand-deriving tick/liquidity math (and risking a silent error in
///         concentrated-liquidity arithmetic that a Solidity library
///         already gets right).
contract V4TestMath {
    function minUsableTick(int24 tickSpacing) external pure returns (int24) {
        return TickMath.minUsableTick(tickSpacing);
    }

    function maxUsableTick(int24 tickSpacing) external pure returns (int24) {
        return TickMath.maxUsableTick(tickSpacing);
    }

    function getSqrtPriceAtTick(int24 tick) external pure returns (uint160) {
        return TickMath.getSqrtPriceAtTick(tick);
    }

    function getLiquidityForAmounts(
        uint160 sqrtPriceX96,
        uint160 sqrtPriceAX96,
        uint160 sqrtPriceBX96,
        uint256 amount0,
        uint256 amount1
    ) external pure returns (uint128) {
        return LiquidityAmounts.getLiquidityForAmounts(sqrtPriceX96, sqrtPriceAX96, sqrtPriceBX96, amount0, amount1);
    }
}
