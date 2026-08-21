// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mintable ERC20 for testing/demoing AncillaSwapPool +
///         SwapExecutor. Not part of the privacy protocol itself — this is
///         a stand-in for "some real token an agent wants to swap," the way
///         MockExecutor was a stand-in for "some real protocol." Anyone can
///         mint, which is correct for a testnet/test-only token and would
///         be wrong for anything real — this contract must never be used
///         beyond that.
contract TestToken is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
