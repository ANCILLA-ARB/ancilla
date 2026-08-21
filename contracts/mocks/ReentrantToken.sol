// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deliberately malicious mock used ONLY in tests to prove
///         AncillaSwapPool's `nonReentrant` guard actually blocks
///         reentrancy. A standard OpenZeppelin ERC20 (what TestToken uses)
///         has no transfer hooks, so it can never exercise this path —
///         this is a minimal, self-contained, hook-having "ERC20" built
///         specifically to attempt reentry mid-transfer, the same way
///         ReentrantAttacker.sol does for IntentCommitReveal.
contract ReentrantToken is IERC20 {
    string public constant name = "Reentrant";
    string public constant symbol = "RENT";
    uint8 public constant decimals = 18;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    address public reentryTarget;
    bytes public reentryCalldata;
    bool public reentrySucceeded;

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryCalldata = data;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        _totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @dev Test-only convenience: lets this contract approve a spender to
    ///      move tokens held by this contract's own address, without
    ///      needing an external `approve()` caller (this contract is the
    ///      one doing the reentering, not a normal EOA/contract holder).
    function selfApprove(address spender, uint256 amount) external {
        _allowances[address(this)][spender] = amount;
        emit Approval(address(this), spender, amount);
    }

    function totalSupply() external view override returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) external view override returns (uint256) {
        return _allowances[owner][spender];
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _attemptReentry();
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _attemptReentry();
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= amount, "insufficient allowance");
        _allowances[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "insufficient balance");
        _balances[from] -= amount;
        _balances[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// @dev Called on every transfer/transferFrom — the "hook" a real
    ///      ERC20 doesn't have, standing in for a malicious/nonstandard
    ///      token here specifically to test the pool's own reentrancy
    ///      guard, not to represent any real token behavior.
    function _attemptReentry() internal {
        if (reentryTarget == address(0)) return;
        // Prevent infinite recursion within the attempt itself — only try once.
        address target = reentryTarget;
        reentryTarget = address(0);
        (bool ok, ) = target.call(reentryCalldata);
        reentrySucceeded = ok;
    }
}
