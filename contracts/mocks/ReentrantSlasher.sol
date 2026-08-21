// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISlashable {
    function slashNoReveal(bytes32 commitId) external;
}

/// @notice Deliberately malicious mock used ONLY in tests to prove
///         slashNoReveal()'s new dual-payout (slasher reward + treasury
///         share) can't be exploited by a malicious slasher reentering
///         from the `receive()` hook that fires when its reward arrives.
///         Plays the "slasher" role itself — calls slashNoReveal, and on
///         receiving its reward, immediately tries to call it again on the
///         same commitId before the first call has "finished".
contract ReentrantSlasher {
    ISlashable public target;
    bytes32 public commitId;
    bool public armed;
    bool public reentryReverted;

    constructor(address _target) {
        target = ISlashable(_target);
    }

    function attack(bytes32 _commitId) external {
        commitId = _commitId;
        armed = true;
        target.slashNoReveal(_commitId);
    }

    receive() external payable {
        if (armed) {
            armed = false; // only attempt once
            try target.slashNoReveal(commitId) {
                // If this ever succeeds, the contract double-paid the
                // reward/penalty for one slashed commitment — a real bug.
            } catch {
                reentryReverted = true;
            }
        }
    }
}
