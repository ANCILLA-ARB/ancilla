// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IWithdrawable2 {
    function depositBond() external payable;
    function withdrawBond(uint256 amount) external;
}

/// @notice Deliberately has no receive()/fallback(), so any plain ETH
///         transfer to it reverts. Used only in tests to prove
///         withdrawBond()'s and slashNoReveal()'s `require(ok, ...)` guards
///         actually fire when the ETH transfer itself fails, instead of
///         silently leaving accounting state changed without the payout
///         having happened.
contract RejectingReceiver {
    IWithdrawable2 public target;

    constructor(address _target) {
        target = IWithdrawable2(_target);
    }

    function deposit() external payable {
        target.depositBond{value: msg.value}();
    }

    function tryWithdraw(uint256 amount) external {
        target.withdrawBond(amount);
    }
}
