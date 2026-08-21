// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AncillaTreasuryMultisig
/// @notice A minimal M-of-N multisig built specifically to hold
/// IntentCommitReveal's slashed-bond treasury. Deliberately scoped to ETH
/// custody + withdrawal approval only — no arbitrary call execution, no
/// owner-management functions, no upgradeability. That keeps the attack
/// surface small enough to reason about directly instead of pulling in a
/// general-purpose multisig (e.g. Safe) with far more capability than a
/// slashing treasury actually needs.
///
/// Why this exists: IntentCommitReveal.treasury is `immutable` — set once
/// at deploy and never changeable again. Pointing it at a single EOA (as
/// every testnet deployment so far has done) means one lost or compromised
/// private key permanently and unrecoverably owns every slashed bond ever
/// paid in. Before any mainnet deployment, `_treasury` must be an address
/// like this one instead: no single key can move funds out of it alone.
///
/// Deliberately NOT included, on purpose, for the same reason
/// IntentCommitReveal.treasury itself is immutable — less mutable state is
/// less to get wrong or to attack: owner set and threshold are fixed at
/// construction. Rotating owners means deploying a new multisig and, on
/// the next IntentCommitReveal deployment, pointing `_treasury` at it —
/// not editing this one in place.
contract AncillaTreasuryMultisig is ReentrancyGuard {
    event Deposited(address indexed from, uint256 amount);
    event WithdrawalProposed(uint256 indexed id, address indexed proposer, address indexed to, uint256 amount);
    event WithdrawalConfirmed(uint256 indexed id, address indexed owner);
    event WithdrawalRevoked(uint256 indexed id, address indexed owner);
    event WithdrawalExecuted(uint256 indexed id, address indexed to, uint256 amount);

    error NotOwner();
    error ZeroOwners();
    error DuplicateOwner();
    error ZeroOwnerAddress();
    error InvalidThreshold();
    error ZeroRecipient();
    error InsufficientBalance();
    error WithdrawalDoesNotExist();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error NotConfirmed();
    error NotEnoughConfirmations();
    error TransferFailed();

    struct Withdrawal {
        address to;
        uint256 amount;
        bool executed;
        uint256 confirmations;
    }

    address[] private _owners;
    mapping(address => bool) public isOwner;

    /// @notice How many owner confirmations a withdrawal needs before it
    /// can be executed. Fixed at deploy time, same reasoning as the owner
    /// set itself.
    uint256 public immutable threshold;

    Withdrawal[] public withdrawals;
    mapping(uint256 => mapping(address => bool)) public hasConfirmed;

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        if (owners_.length == 0) revert ZeroOwners();
        if (threshold_ == 0 || threshold_ > owners_.length) revert InvalidThreshold();
        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            if (owner == address(0)) revert ZeroOwnerAddress();
            if (isOwner[owner]) revert DuplicateOwner();
            isOwner[owner] = true;
            _owners.push(owner);
        }
        threshold = threshold_;
    }

    /// @notice Accepts plain ETH transfers — this is how IntentCommitReveal
    /// pays in slashed bonds via `treasury.call{value: penalty}("")`.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    function withdrawalCount() external view returns (uint256) {
        return withdrawals.length;
    }

    /// @notice Proposes moving `amount` ETH to `to`. Counts as the
    /// proposer's own confirmation — a 1-of-N multisig therefore executes
    /// immediately via `proposeWithdrawal` alone, same as any threshold
    /// multisig once enough confirmations exist.
    function proposeWithdrawal(address to, uint256 amount) external onlyOwner returns (uint256 id) {
        if (to == address(0)) revert ZeroRecipient();
        if (amount > address(this).balance) revert InsufficientBalance();
        id = withdrawals.length;
        withdrawals.push(Withdrawal({to: to, amount: amount, executed: false, confirmations: 0}));
        emit WithdrawalProposed(id, msg.sender, to, amount);
        _confirm(id);
    }

    function confirmWithdrawal(uint256 id) external onlyOwner {
        _requireExists(id);
        if (withdrawals[id].executed) revert AlreadyExecuted();
        if (hasConfirmed[id][msg.sender]) revert AlreadyConfirmed();
        _confirm(id);
    }

    function revokeConfirmation(uint256 id) external onlyOwner {
        _requireExists(id);
        if (withdrawals[id].executed) revert AlreadyExecuted();
        if (!hasConfirmed[id][msg.sender]) revert NotConfirmed();
        hasConfirmed[id][msg.sender] = false;
        withdrawals[id].confirmations -= 1;
        emit WithdrawalRevoked(id, msg.sender);
    }

    /// @notice Sends the withdrawal's ETH once it has >= threshold
    /// confirmations. Marks `executed = true` before the external call
    /// (checks-effects-interactions); if the transfer fails for any
    /// reason — including a malicious recipient trying to reenter this
    /// same function from its `receive()` hook — the whole call reverts,
    /// which unwinds `executed` back to `false` along with everything
    /// else, so a failed send can always be retried rather than getting
    /// stuck half-executed. `nonReentrant` is added on top as
    /// defense-in-depth, matching the pattern already used in
    /// AncillaSwapPool.
    function executeWithdrawal(uint256 id) external onlyOwner nonReentrant {
        _requireExists(id);
        Withdrawal storage w = withdrawals[id];
        if (w.executed) revert AlreadyExecuted();
        if (w.confirmations < threshold) revert NotEnoughConfirmations();
        if (w.amount > address(this).balance) revert InsufficientBalance();
        w.executed = true;
        (bool ok, ) = w.to.call{value: w.amount}("");
        if (!ok) revert TransferFailed();
        emit WithdrawalExecuted(id, w.to, w.amount);
    }

    function _confirm(uint256 id) private {
        hasConfirmed[id][msg.sender] = true;
        withdrawals[id].confirmations += 1;
        emit WithdrawalConfirmed(id, msg.sender);
    }

    function _requireExists(uint256 id) private view {
        if (id >= withdrawals.length) revert WithdrawalDoesNotExist();
    }
}
