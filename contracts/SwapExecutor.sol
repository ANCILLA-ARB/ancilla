// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IIntentExecutor} from "./IIntentExecutor.sol";
import {AncillaSwapPool} from "./AncillaSwapPool.sol";

/// @title SwapExecutor
/// @notice The first REAL (non-mock) `IIntentExecutor` implementation in
///         this repo — bridges a revealed Ancilla intent to an actual token
///         swap against AncillaSwapPool. This is the piece that makes the
///         project's core narrative (privacy-preserving DeFi swap intents)
///         demonstrable end-to-end instead of stopping at "a hash matched."
///
///         Flow: an agent decides to swap, encodes
///         `abi.encode(tokenIn, amountIn, minAmountOut)` as `intentData`,
///         commits its hash (content hidden), and separately approves this
///         contract to pull `amountIn` of `tokenIn` on its behalf — same
///         "approve the router" pattern any DEX aggregator uses. Once the
///         batch reveal window opens, revealing calls back into
///         `executeIntent`, which pulls the tokens from the agent, sends
///         them into the pool, and returns the swap output straight to the
///         agent. Everyone watching the chain sees the swap only at the
///         reveal — not before, when it was still hidden inside a batch of
///         many agents' commitments.
///
///         NOT covered by this contract: MEV protection on the swap's
///         *price* itself. `minAmountOut` guards against slippage, but a
///         searcher who front-runs the *reveal* transaction (which is
///         plaintext once submitted — see the main README's "What this
///         does NOT do") could still sandwich the pool trade at that
///         moment. Batching many reveals together (Ancilla's actual
///         privacy mechanism) raises the cost/reliability of doing that
///         compared to a single isolated swap, but does not eliminate it.
///         Don't market this as "MEV-proof swaps" — it demonstrably isn't.
contract SwapExecutor is IIntentExecutor {
    using SafeERC20 for IERC20;

    AncillaSwapPool public immutable pool;

    event IntentSwapExecuted(address indexed agent, address indexed tokenIn, uint256 amountIn, uint256 amountOut);

    error PoolIsZeroAddress();
    error IntentDataMalformed();

    constructor(address _pool) {
        if (_pool == address(0)) revert PoolIsZeroAddress();
        pool = AncillaSwapPool(_pool);
    }

    /// @dev Called by IntentCommitReveal during a reveal. `agent` is the
    ///      party whose commitment this was (already authenticated by the
    ///      caller before this executes — see IntentCommitReveal.sol); this
    ///      contract does not re-check that, it trusts its caller the same
    ///      way MockExecutor does.
    function executeIntent(address agent, bytes calldata intentData) external override returns (bool success) {
        (address tokenIn, uint256 amountIn, uint256 minAmountOut) = _decode(intentData);

        IERC20 tokenInErc20 = IERC20(tokenIn);
        tokenInErc20.safeTransferFrom(agent, address(this), amountIn);
        tokenInErc20.forceApprove(address(pool), amountIn);

        uint256 amountOut = pool.swap(tokenInErc20, amountIn, minAmountOut, agent);

        emit IntentSwapExecuted(agent, tokenIn, amountIn, amountOut);
        return true;
    }

    function _decode(bytes calldata intentData) internal pure returns (address tokenIn, uint256 amountIn, uint256 minAmountOut) {
        if (intentData.length != 96) revert IntentDataMalformed(); // 3 * 32-byte words
        (tokenIn, amountIn, minAmountOut) = abi.decode(intentData, (address, uint256, uint256));
    }
}
