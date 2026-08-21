// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

/// @title AncillaToken (ANCILLA)
/// @notice The protocol's governance/utility token. Deliberately minimal on
/// its own terms — supply, allocation, and vesting are NOT this contract's
/// job and are not encoded here; those are tokenomics decisions made once,
/// off-chain and at deploy/distribution time, not something to hardcode
/// into an ERC20 that then has to be redeployed if the numbers change.
/// What this contract DOES commit to on-chain:
///   - A hard, immutable supply cap (`ERC20Capped`) — minting can never
///     exceed it, regardless of who holds the owner role later.
///   - On-chain vote-weight tracking (`ERC20Votes`) via OpenZeppelin's
///     standard checkpoint system, so a token balance IS voting power
///     without a separate wrapper/staking step — required by
///     `AncillaGovernor` (see that contract).
///   - Gasless approvals (`ERC20Permit`) — standard for anything meant to
///     be staked or delegated without a separate approve() transaction.
///
/// `owner` can mint, up to the cap — same "single EOA at first, migrate to
/// real governance later" MVP pattern already used for `treasury` and
/// `guardian` in IntentCommitReveal.sol (see that contract's header
/// comment): the deployer starts as owner, and should transfer ownership
/// to a multisig or to `AncillaTimelock` (once real governance is trusted
/// enough to control emissions) before any real distribution happens.
/// `Ownable.transferOwnership` and `renounceOwnership` are both available
/// for exactly that migration.
contract AncillaToken is ERC20, ERC20Permit, ERC20Votes, ERC20Capped, Ownable {
    constructor(
        uint256 cap,
        address initialOwner
    ) ERC20("Ancilla", "ANCILLA") ERC20Permit("Ancilla") ERC20Capped(cap) Ownable(initialOwner) {}

    /// @notice Mints `amount` to `to`, up to the immutable cap. Reverts via
    /// ERC20Capped's own check if it would exceed the cap — not re-checked
    /// here, no reason to duplicate that logic.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // ---------------------------------------------------------------
    // The functions below are NOT new behavior — they're Solidity's
    // required disambiguation for a token that inherits _update()/nonces()
    // along two different paths (ERC20Votes and ERC20Capped both hook
    // _update(); ERC20Permit and the base Nonces both define nonces()).
    // This is the standard shape for this exact combination, not a
    // custom addition.
    // ---------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes, ERC20Capped) {
        super._update(from, to, value);
    }

    function nonces(address owner_) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner_);
    }

    /// @notice Voting checkpoints (and AncillaGovernor, which follows this
    /// token's clock — see GovernorVotes.clock()) run on real wall-clock
    /// timestamps, NOT the default block-number mode. On Arbitrum, the
    /// `block.number` opcode a contract sees is the L1 Ethereum block
    /// height, not the L2 block count RPC tooling (ethers'
    /// getBlockNumber(), any explorer) reports — two completely different
    /// counters advancing at different rates. Block-number voting
    /// snapshots would be checked against the wrong scale entirely. Same
    /// reasoning IntentCommitReveal.sol already documents for using
    /// block.timestamp-based epochs instead of block-count ones.
    function clock() public view override returns (uint48) {
        return Time.timestamp();
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
