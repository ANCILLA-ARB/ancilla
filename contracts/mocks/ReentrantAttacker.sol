// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWithdrawable {
    function depositBond() external payable;
    function withdrawBond(uint256 amount) external;
}

/// @notice Deliberately malicious mock used ONLY in tests to prove
///         IntentCommitReveal.withdrawBond() is not vulnerable to the
///         classic reentrancy-drain pattern (same shape as the 2016 DAO
///         hack): deposit, call withdraw, and in `receive()` — triggered by
///         the outgoing ETH transfer — immediately call withdraw again
///         before the outer call has "finished", trying to pull out more
///         than was actually deposited.
contract ReentrantAttacker {
    IWithdrawable public target;
    uint256 public withdrawAmount;
    uint8 public reentryAttempts;
    uint8 public reentrySuccesses;
    uint8 public constant MAX_ATTEMPTS = 3;

    constructor(address _target) {
        target = IWithdrawable(_target);
    }

    function fund() external payable {}

    function deposit() external {
        target.depositBond{value: address(this).balance}();
    }

    function attack(uint256 amount) external {
        withdrawAmount = amount;
        reentryAttempts = 0;
        reentrySuccesses = 0;
        target.withdrawBond(amount);
    }

    receive() external payable {
        if (reentryAttempts < MAX_ATTEMPTS) {
            reentryAttempts++;
            // Try to withdraw the SAME amount again, before this call stack
            // unwinds — the DAO-hack pattern. If IntentCommitReveal updates
            // bondBalance BEFORE sending ETH (checks-effects-interactions),
            // this second call sees an already-reduced (or zero) balance and
            // must fail. If it *succeeds*, that's a real drain vulnerability.
            try target.withdrawBond(withdrawAmount) {
                reentrySuccesses++;
            } catch {
                // expected path if the contract is safe
            }
        }
    }
}
