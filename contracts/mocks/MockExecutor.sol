// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIntentExecutor} from "../IIntentExecutor.sol";

/// @notice Stand-in for a real protocol (DEX router, vault, etc.) used only
///         in tests to prove the reveal -> execution hop actually works.
contract MockExecutor is IIntentExecutor {
    event Executed(address indexed agent, bytes intentData);

    bool public shouldFail;

    function setShouldFail(bool v) external {
        shouldFail = v;
    }

    function executeIntent(address agent, bytes calldata intentData) external override returns (bool) {
        if (shouldFail) return false;
        emit Executed(agent, intentData);
        return true;
    }
}
