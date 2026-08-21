// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AncillaStaking
/// @notice Stake ANCILLA, earn a pro-rata share of ETH revenue the
/// protocol sends here. Deliberately does NOT invent a new revenue
/// stream — the intended source is AncillaTreasuryMultisig, which
/// already holds every slashed bond and already has a working, tested,
/// live-proven `proposeWithdrawal` / `executeWithdrawal` flow (2-of-3
/// confirmation). That flow sends plain ETH with no calldata, so this
/// contract's `receive()` — not a separate "notifyRevenue" function
/// owners would have to remember to call — is where a treasury payout
/// lands and gets distributed. Nothing about AncillaTreasuryMultisig.sol
/// needed to change for this to work.
///
/// Distribution math is the standard "scalable reward distribution"
/// accumulator (the same family as Synthetix's StakingRewards, minus a
/// time-based emission rate — funding here arrives in irregular lumps
/// whenever the treasury multisig decides to distribute, not as a
/// continuous stream, so there's no rate to track): every ETH deposit
/// increases a global `rewardPerTokenStored` proportional to
/// `totalStaked` at that moment; each staker's owed amount is the
/// difference between the current accumulator and whatever value it was
/// at when they last staked/withdrew/claimed, times their stake. This is
/// O(1) per stake/withdraw/claim regardless of staker count — no loops
/// over a staker list, which is exactly the kind of unbounded-loop
/// footgun a real payout contract can't afford.
///
/// Reverts (not silently no-ops) if ETH arrives while `totalStaked == 0`
/// — there's no one to distribute to yet, and silently absorbing it
/// would either strand the funds or let the next staker claim ETH they
/// weren't actually owed.
contract AncillaStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAmount();
    error InsufficientStake();
    error NoStakersYet();

    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event RevenueDistributed(uint256 amount, uint256 totalStakedAtTime);

    IERC20 public immutable stakingToken;

    uint256 public totalStaked;
    mapping(address => uint256) public staked;

    uint256 private constant PRECISION = 1e18;
    uint256 public rewardPerTokenStored;
    mapping(address => uint256) private userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    constructor(IERC20 _stakingToken) {
        stakingToken = _stakingToken;
    }

    /// @notice Any plain ETH transfer (e.g. AncillaTreasuryMultisig's
    /// executeWithdrawal) is treated as revenue and distributed pro-rata
    /// to whoever is staked at that moment.
    receive() external payable {
        _distribute(msg.value);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _updateReward(msg.sender);
        totalStaked += amount;
        staked[msg.sender] += amount;
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _updateReward(msg.sender);
        totalStaked -= amount;
        staked[msg.sender] -= amount;
        stakingToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pays out accrued ETH rewards. Callable any time; also run
    /// implicitly by stake()/withdraw() so a staker's owed amount never
    /// goes stale between explicit claims.
    function claim() external nonReentrant {
        _updateReward(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: reward}("");
        require(ok, "ETH transfer failed");
        emit Claimed(msg.sender, reward);
    }

    /// @notice What `account` would receive from claim() right now,
    /// without needing to send a transaction first.
    function earned(address account) external view returns (uint256) {
        return rewards[account] + (staked[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / PRECISION;
    }

    function _distribute(uint256 amount) private {
        if (totalStaked == 0) revert NoStakersYet();
        rewardPerTokenStored += (amount * PRECISION) / totalStaked;
        emit RevenueDistributed(amount, totalStaked);
    }

    function _updateReward(address account) private {
        rewards[account] += (staked[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / PRECISION;
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }
}
