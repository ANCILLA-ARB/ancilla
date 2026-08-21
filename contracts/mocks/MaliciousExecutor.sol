// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIntentExecutor} from "../IIntentExecutor.sol";

/// @notice Deliberately malicious mock used ONLY in tests. When
///         `executeIntent` is called back by IntentCommitReveal (mid-reveal,
///         before that outer call has returned), this attempts an arbitrary
///         reentrant call into IntentCommitReveal — e.g. trying to reveal
///         the SAME commitment a second time during its own first reveal.
///         Uses a low-level `call` (not the typed interface) so a revert on
///         the reentrant attempt does not also revert the legitimate outer
///         reveal — that way the test can inspect what happened afterward
///         instead of the whole transaction just dying.
contract MaliciousExecutor is IIntentExecutor {
    address public reentryTarget;
    bytes public reentryCalldata;
    bool public reentrySucceeded;

    function setReentry(address _target, bytes calldata _calldata) external {
        reentryTarget = _target;
        reentryCalldata = _calldata;
    }

    function executeIntent(address /* agent */, bytes calldata /* intentData */) external override returns (bool) {
        if (reentryTarget != address(0)) {
            (bool ok, ) = reentryTarget.call(reentryCalldata);
            reentrySucceeded = ok;
        }
        return true;
    }
}
