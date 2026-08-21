// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AncillaVoteEscrow
/// @notice Lock ANCILLA for a chosen duration (4 weeks to 2 years) and earn
/// a pro-rata share of ETH revenue weighted by HOW LONG you committed, not
/// just how much you hold — `weight = amount * lockDuration / MAX_LOCK`.
/// A 2-year lock earns proportionally more per token than a 4-week one.
///
/// This is not an original mechanism — it's the same vote-escrow ("ve")
/// pattern proven across Curve's veCRV, Balancer's veBAL, and 1inch
/// Fusion's "Unicorn Power" (staked 1INCH locked 1 month to 2 years,
/// weighted by duration, determines resolver eligibility and reward
/// share). Adopted here deliberately instead of inventing a new one —
/// see README's "ANCILLA token & governance" section for the fuller
/// reasoning and what was compared against before building this.
///
/// Deliberately separate from AncillaStaking, not a replacement for it —
/// both can be funded from AncillaTreasuryMultisig's existing withdrawal
/// flow (see AncillaStaking.sol's header comment for why that flow works
/// with any contract exposing a plain `receive()`), and it's a
/// treasury-governance decision how revenue splits between "flexible,
/// withdraw-anytime" staking (AncillaStaking) and "committed, boosted"
/// locking (this contract) — not something hardcoded here.
///
/// Deliberately NOT wired into AncillaGovernor's voting power in this
/// version. That's the natural next step a vote-escrow position enables
/// (the name is forward-looking on purpose), but doing it correctly means
/// either giving this contract's weight real ERC-6372 checkpoint history
/// (so past-block/past-timestamp lookups during a live proposal stay
/// accurate as locks mature and new ones are created) or accepting
/// weaker guarantees than AncillaToken's existing ERC20Votes checkpoints
/// provide — a real governance-security decision, not a small addition,
/// deliberately not made here.
///
/// One lock per address at a time (no top-up or extension in this
/// version) — a simplification, not an oversight: recomputing weight
/// correctly on top-up/extend without breaking the reward accounting
/// below needs more care than this pass's scope. Withdraw a matured lock,
/// then start a new one.
contract AncillaVoteEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAmount();
    error LockTooShort();
    error LockTooLong();
    error NoActiveLock();
    error LockNotMatured(uint256 unlockTime);
    error LockAlreadyActive();
    error NoLockersYet();

    event Locked(address indexed account, uint256 amount, uint256 unlockTime, uint256 weight);
    event Withdrawn(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event RevenueDistributed(uint256 amount, uint256 totalWeightAtTime);

    IERC20 public immutable ancilla;

    uint256 public constant MIN_LOCK = 4 weeks;
    uint256 public constant MAX_LOCK = 104 weeks; // 2 years — matches 1inch Fusion's Unicorn Power range

    struct Lock {
        uint256 amount;
        uint256 unlockTime;
        uint256 weight;
    }
    mapping(address => Lock) public locks;
    uint256 public totalWeight;

    uint256 private constant PRECISION = 1e18;
    uint256 public rewardPerWeightStored;
    mapping(address => uint256) private userRewardPerWeightPaid;
    mapping(address => uint256) public rewards;

    constructor(IERC20 _ancilla) {
        ancilla = _ancilla;
    }

    /// @notice Same "plain ETH transfer IS revenue" pattern as
    /// AncillaStaking — a treasury multisig withdrawal with no calldata
    /// lands here and distributes automatically.
    receive() external payable {
        _distribute(msg.value);
    }

    function lock(uint256 amount, uint256 lockDuration) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (lockDuration < MIN_LOCK) revert LockTooShort();
        if (lockDuration > MAX_LOCK) revert LockTooLong();
        if (locks[msg.sender].amount != 0) revert LockAlreadyActive();

        _updateReward(msg.sender);

        uint256 unlockTime = block.timestamp + lockDuration;
        uint256 weight = (amount * lockDuration) / MAX_LOCK;
        locks[msg.sender] = Lock({amount: amount, unlockTime: unlockTime, weight: weight});
        totalWeight += weight;

        ancilla.safeTransferFrom(msg.sender, address(this), amount);
        emit Locked(msg.sender, amount, unlockTime, weight);
    }

    /// @notice Returns the locked ANCILLA once (and only once) the lock
    /// has matured. Reverts rather than allowing early exit — that's the
    /// entire point of a time-committed lock; a lock that could be broken
    /// early would be indistinguishable from ordinary flexible staking.
    function withdraw() external nonReentrant {
        Lock memory l = locks[msg.sender];
        if (l.amount == 0) revert NoActiveLock();
        if (block.timestamp < l.unlockTime) revert LockNotMatured(l.unlockTime);

        _updateReward(msg.sender);
        totalWeight -= l.weight;
        delete locks[msg.sender];

        ancilla.safeTransfer(msg.sender, l.amount);
        emit Withdrawn(msg.sender, l.amount);
    }

    function claim() external nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: reward}("");
        require(ok, "ETH transfer failed");
        emit Claimed(msg.sender, reward);
    }

    /// @notice What `account` would receive from claim() right now.
    function earned(address account) external view returns (uint256) {
        return rewards[account] + (locks[account].weight * (rewardPerWeightStored - userRewardPerWeightPaid[account])) / PRECISION;
    }

    function _distribute(uint256 amount) private {
        if (totalWeight == 0) revert NoLockersYet();
        rewardPerWeightStored += (amount * PRECISION) / totalWeight;
        emit RevenueDistributed(amount, totalWeight);
    }

    function _updateReward(address account) private {
        rewards[account] += (locks[account].weight * (rewardPerWeightStored - userRewardPerWeightPaid[account])) / PRECISION;
        userRewardPerWeightPaid[account] = rewardPerWeightStored;
    }
}
