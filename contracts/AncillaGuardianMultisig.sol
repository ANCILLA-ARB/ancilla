// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice The exact two functions this multisig is allowed to ever call
/// on a target contract — see AncillaGuardianMultisig's header for why the
/// target itself is chosen per-proposal instead of fixed at construction.
interface IPausableGuarded {
    function pause() external;
    function unpause() external;
}

/// @title AncillaGuardianMultisig
/// @notice A minimal M-of-N multisig scoped to calling exactly two
/// functions — pause() and unpause() — on a target address named by the
/// proposal itself. Same minimal-attack-surface philosophy as
/// AncillaTreasuryMultisig: no arbitrary calldata, no owner-management
/// functions, no upgradeability.
///
/// Why the target isn't fixed at construction, unlike the treasury
/// multisig pointing at nothing external: IntentCommitReveal.guardian and
/// AncillaSwapHook.guardian are both `immutable`, set once at THEIR
/// construction. A guardian multisig bound to one target at ITS OWN
/// construction would create a circular dependency — the target contract
/// doesn't exist yet to be pointed at when this contract is deployed, and
/// this contract's address isn't known ahead of the target's deployment
/// either, without CREATE2 address mining neither side otherwise needs.
/// Letting each proposal name its own target sidesteps that cleanly, and
/// as a side effect lets one guardian multisig supervise pausing across
/// every Ancilla contract deployed with `guardian` pointed at it, not just
/// one — without ever expanding what it's capable of calling. The security
/// bar is identical either way: owners can only ever trigger pause() or
/// unpause(), on a target of their own choosing, never arbitrary calldata.
/// (This is unlike the treasury multisig, where the recipient of moved
/// funds genuinely needs to be fixed — pause/unpause don't move value, so
/// target flexibility here isn't a fund-safety risk the way it would be
/// there.)
///
/// Execution deliberately does NOT swallow a failed call in a try/catch —
/// pause()/unpause() are called directly, so if the target reverts (e.g.
/// this multisig's address isn't actually set as that contract's
/// `guardian`, surfacing NotGuardian), that real revert reason propagates
/// to the caller instead of being replaced with a generic error, and
/// (checks-effects-interactions) the whole transaction — including the
/// `executed = true` write — unwinds, so a failed attempt can always be
/// retried rather than getting stuck half-executed.
contract AncillaGuardianMultisig {
    enum Action {
        Pause,
        Unpause
    }

    event Proposed(uint256 indexed id, address indexed proposer, address indexed target, Action action);
    event Confirmed(uint256 indexed id, address indexed owner);
    event Revoked(uint256 indexed id, address indexed owner);
    event Executed(uint256 indexed id, address indexed target, Action action);

    error NotOwner();
    error ZeroOwners();
    error DuplicateOwner();
    error ZeroOwnerAddress();
    error InvalidThreshold();
    error ZeroTarget();
    error ProposalDoesNotExist();
    error AlreadyExecuted();
    error AlreadyConfirmed();
    error NotConfirmed();
    error NotEnoughConfirmations();

    struct Proposal {
        address target;
        Action action;
        bool executed;
        uint256 confirmations;
    }

    address[] private _owners;
    mapping(address => bool) public isOwner;

    /// @notice How many owner confirmations a proposal needs before it can
    /// be executed. Fixed at deploy time, same reasoning as the owner set
    /// itself — see AncillaTreasuryMultisig's header comment.
    uint256 public immutable threshold;

    Proposal[] public proposals;
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

    function owners() external view returns (address[] memory) {
        return _owners;
    }

    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    function proposalCount() external view returns (uint256) {
        return proposals.length;
    }

    /// @notice Proposes calling pause() on `target`. Counts as the
    /// proposer's own confirmation, same as AncillaTreasuryMultisig's
    /// proposeWithdrawal — a 1-of-N guardian multisig therefore executes
    /// immediately via this alone.
    function proposePause(address target) external onlyOwner returns (uint256 id) {
        id = _propose(target, Action.Pause);
    }

    function proposeUnpause(address target) external onlyOwner returns (uint256 id) {
        id = _propose(target, Action.Unpause);
    }

    function confirm(uint256 id) external onlyOwner {
        _requireExists(id);
        if (proposals[id].executed) revert AlreadyExecuted();
        if (hasConfirmed[id][msg.sender]) revert AlreadyConfirmed();
        _confirm(id);
    }

    function revokeConfirmation(uint256 id) external onlyOwner {
        _requireExists(id);
        if (proposals[id].executed) revert AlreadyExecuted();
        if (!hasConfirmed[id][msg.sender]) revert NotConfirmed();
        hasConfirmed[id][msg.sender] = false;
        proposals[id].confirmations -= 1;
        emit Revoked(id, msg.sender);
    }

    /// @notice Executes a proposal once it has >= threshold confirmations
    /// — see the contract's header comment for why a failed call here
    /// reverts the whole transaction instead of being caught.
    function execute(uint256 id) external onlyOwner {
        _requireExists(id);
        Proposal storage p = proposals[id];
        if (p.executed) revert AlreadyExecuted();
        if (p.confirmations < threshold) revert NotEnoughConfirmations();
        p.executed = true;
        if (p.action == Action.Pause) {
            IPausableGuarded(p.target).pause();
        } else {
            IPausableGuarded(p.target).unpause();
        }
        emit Executed(id, p.target, p.action);
    }

    function _propose(address target, Action action) private returns (uint256 id) {
        if (target == address(0)) revert ZeroTarget();
        id = proposals.length;
        proposals.push(Proposal({target: target, action: action, executed: false, confirmations: 0}));
        emit Proposed(id, msg.sender, target, action);
        _confirm(id);
    }

    function _confirm(uint256 id) private {
        hasConfirmed[id][msg.sender] = true;
        proposals[id].confirmations += 1;
        emit Confirmed(id, msg.sender);
    }

    function _requireExists(uint256 id) private view {
        if (id >= proposals.length) revert ProposalDoesNotExist();
    }
}
