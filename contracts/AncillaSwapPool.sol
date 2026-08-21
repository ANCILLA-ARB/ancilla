// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AncillaSwapPool
/// @notice A minimal constant-product (x*y=k) AMM for exactly one token
///         pair, built so SwapExecutor has something real to execute a
///         revealed swap intent against — not a production AMM.
///
///         DELIBERATE SIMPLIFICATIONS (be honest about these):
///          - No LP tokens. Liquidity added via `addLiquidity` is NOT
///            represented by any withdrawable claim — there is no
///            `removeLiquidity`. This pool exists to make swaps real, not
///            to be a fair or usable liquidity venue. Do not treat
///            deposited liquidity as recoverable.
///          - Single pair, fixed at deployment. No factory, no multi-hop.
///          - 0.3% fee (Uniswap V2's constant), fee accrues into the pool
///            reserves rather than being claimable separately — with no LP
///            tokens, there's no mechanism to claim it anyway.
///          - No price oracle / TWAP, no flash-loan protection beyond the
///            reentrancy guard. A pool this small is trivially manipulable
///            — never point real value at this contract.
contract AncillaSwapPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable tokenA;
    IERC20 public immutable tokenB;

    uint256 public reserveA;
    uint256 public reserveB;

    uint256 private constant FEE_NUMERATOR = 997; // 0.3% fee, Uniswap V2 convention
    uint256 private constant FEE_DENOMINATOR = 1000;

    event LiquidityAdded(address indexed provider, uint256 amountA, uint256 amountB);
    event Swap(address indexed sender, address indexed tokenIn, uint256 amountIn, address indexed tokenOut, uint256 amountOut, address recipient);

    error IdenticalTokens();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownToken(address token);
    error InsufficientLiquidity();
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);

    constructor(address _tokenA, address _tokenB) {
        if (_tokenA == address(0) || _tokenB == address(0)) revert ZeroAddress();
        if (_tokenA == _tokenB) revert IdenticalTokens();
        tokenA = IERC20(_tokenA);
        tokenB = IERC20(_tokenB);
    }

    /// @notice Adds liquidity at whatever ratio the caller sends — no
    ///         proportional-deposit enforcement, no LP tokens minted (see
    ///         header comment). Fine for seeding a demo pool; a caller
    ///         adding at a bad ratio just moves the price, same as any
    ///         constant-product pool.
    function addLiquidity(uint256 amountA, uint256 amountB) external nonReentrant {
        if (amountA == 0 || amountB == 0) revert ZeroAmount();
        reserveA += amountA;
        reserveB += amountB;
        tokenA.safeTransferFrom(msg.sender, address(this), amountA);
        tokenB.safeTransferFrom(msg.sender, address(this), amountB);
        emit LiquidityAdded(msg.sender, amountA, amountB);
    }

    /// @notice Standard Uniswap V2 constant-product-with-fee formula.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * FEE_DENOMINATOR + amountInWithFee;
        return numerator / denominator;
    }

    /// @param tokenIn      must be `tokenA` or `tokenB`
    /// @param amountIn     amount of `tokenIn` pulled from msg.sender
    /// @param minAmountOut slippage floor — reverts if the actual output would be less
    /// @param recipient    who receives the output token
    function swap(IERC20 tokenIn, uint256 amountIn, uint256 minAmountOut, address recipient) external nonReentrant returns (uint256 amountOut) {
        if (recipient == address(0)) revert ZeroAddress();
        bool inIsA = address(tokenIn) == address(tokenA);
        if (!inIsA && address(tokenIn) != address(tokenB)) revert UnknownToken(address(tokenIn));

        (uint256 reserveIn, uint256 reserveOut) = inIsA ? (reserveA, reserveB) : (reserveB, reserveA);
        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);
        // Defense-in-depth, not expected to ever fire: the constant-product
        // -with-fee formula above is asymptotic in amountIn — amountOut
        // strictly approaches reserveOut as amountIn grows but, under
        // Solidity's floor division, never reaches it (checked directly
        // with amountIn up to 1e40 tokens before writing this comment, not
        // assumed). This guard exists in case that invariant is ever
        // broken by a future change to getAmountOut, not because it's
        // reachable today. The reachable InsufficientLiquidity path is
        // getAmountOut's own zero-reserve check just above.
        if (amountOut >= reserveOut) revert InsufficientLiquidity();

        // Effects before interactions.
        if (inIsA) {
            reserveA += amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += amountIn;
            reserveA -= amountOut;
        }

        IERC20 tokenOut = inIsA ? tokenB : tokenA;
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tokenOut.safeTransfer(recipient, amountOut);

        emit Swap(msg.sender, address(tokenIn), amountIn, address(tokenOut), amountOut, recipient);
    }
}
