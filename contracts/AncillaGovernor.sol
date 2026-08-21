// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title AncillaGovernor
/// @notice On-chain voting over AncillaToken (ANCILLA) balances, executing
/// through an AncillaTimelock (a plain OpenZeppelin `TimelockController`,
/// deployed directly — no wrapper contract needed, see deploy-token.ts).
/// Standard OpenZeppelin Governor composition, not custom voting logic:
/// GovernorVotes reads voting power from AncillaToken's ERC20Votes
/// checkpoints, GovernorCountingSimple is a plain For/Against/Abstain
/// count, GovernorVotesQuorumFraction sets quorum as a percentage of
/// total supply at proposal-creation time, GovernorTimelockControl routes
/// every successful proposal through the timelock delay before it can
/// execute — nothing here bypasses that delay, including this contract
/// itself; `updateTimelock`, `setVotingDelay`, etc. are all `onlyGovernance`
/// (callable only via a passed, queued, executed proposal, never directly).
///
/// What this contract does NOT yet do: it has no wiring into
/// IntentCommitReveal or AncillaSwapHook. Their `treasury`/`guardian`
/// fields are `immutable`, set once at construction — token-holder
/// governance over them would mean either a new deployment of those
/// contracts with a governance-controlled address in that slot, or a
/// deeper redesign making those fields mutable-by-timelock instead of
/// immutable. That's a real architecture decision affecting the base
/// protocol's security model, deliberately not made here — this contract
/// is voting infrastructure, ready to govern whatever it's pointed at
/// once that decision is made (starting with AncillaStaking's own
/// parameters, which it already can).
///
/// Voting delay/period/threshold and quorum below are constructor
/// arguments, not hardcoded — see deploy-token.ts for the values used on
/// Sepolia, deliberately fast for demoing, explicitly NOT tuned for a
/// real deployment (same "testnet-sized, not production-sized" pattern
/// as IntentCommitReveal's MIN_BOND).
contract AncillaGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(
        IVotes token,
        TimelockController timelockAddress,
        uint48 initialVotingDelay,
        uint32 initialVotingPeriod,
        uint256 initialProposalThreshold,
        uint256 quorumNumeratorValue
    )
        Governor("AncillaGovernor")
        GovernorSettings(initialVotingDelay, initialVotingPeriod, initialProposalThreshold)
        GovernorVotes(token)
        GovernorVotesQuorumFraction(quorumNumeratorValue)
        GovernorTimelockControl(timelockAddress)
    {}

    // ---------------------------------------------------------------
    // Everything below is Solidity's required disambiguation across this
    // combination of standard OpenZeppelin modules — not custom logic.
    // ---------------------------------------------------------------

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns (uint256) {
        return super.quorum(timepoint);
    }

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
