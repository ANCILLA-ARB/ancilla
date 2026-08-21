// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IAncillaTreasuryMultisig {
    function executeWithdrawal(uint256 id) external;
}

/// @notice Deliberately malicious multisig "owner" used only by tests, to
/// prove AncillaTreasuryMultisig.executeWithdrawal cannot be double-spent
/// by reentering it from the withdrawal recipient's own `receive()` hook.
/// This contract plays both roles at once — it's an owner (so it can be
/// counted toward the confirmation threshold) and the withdrawal
/// recipient (so its `receive()` fires mid-transfer).
contract ReentrantTreasuryOwner {
    IAncillaTreasuryMultisig public immutable multisig;
    uint256 public targetId;
    bool public armed;
    bool public reentryReverted;

    constructor(address _multisig) {
        multisig = IAncillaTreasuryMultisig(_multisig);
    }

    function arm(uint256 id) external {
        targetId = id;
        armed = true;
    }

    function execute(uint256 id) external {
        multisig.executeWithdrawal(id);
    }

    receive() external payable {
        if (armed) {
            armed = false; // only attempt once, avoid infinite recursion on failure paths
            try multisig.executeWithdrawal(targetId) {
                // If this ever succeeds, the reentrancy guard failed —
                // the test asserts this branch is never taken.
            } catch {
                reentryReverted = true;
            }
        }
    }
}
