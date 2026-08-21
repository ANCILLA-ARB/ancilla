// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Interface that any protocol (DEX router, vault, etc.) must implement
///         to accept revealed agent intents from IntentCommitReveal.
///         Keeping execution abstracted out of the privacy layer means this
///         contract stays a reusable "batching + commit-reveal" primitive,
///         not tied to one specific DeFi action.
interface IIntentExecutor {
    /// @param agent      the address that originally committed the intent
    /// @param intentData ABI-encoded payload the executor knows how to decode
    /// @return success    whether the intent executed correctly
    function executeIntent(address agent, bytes calldata intentData) external returns (bool success);
}
