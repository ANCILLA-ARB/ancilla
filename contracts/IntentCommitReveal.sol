// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IIntentExecutor} from "./IIntentExecutor.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title IntentCommitReveal (Ancilla protocol)
/// @notice Phase 1+2 privacy primitive for AI-agent transaction intents on Arbitrum.
///         Ancilla (Latin: a trusted attendant acting on someone's behalf) —
///         this contract is the core module: agents commit their intent as a
///         hash, then reveal it only inside a shared batch window.
///
///         WHAT THIS DOES:
///          - Agents commit a hash of their intent instead of broadcasting it in
///            plaintext, so the intent content is hidden while it sits in the
///            public mempool/sequencer queue.
///          - Reveals are only accepted inside a fixed, shared "reveal window"
///            that lines up for every commitment made in the same epoch, so
///            many agents' intents surface together (batching) instead of one
///            at a time — this is what makes per-agent timing correlation hard,
///            not the hashing by itself.
///          - Agents that commit and then never reveal forfeit a bond, so
///            spamming commitments to grief the batch has a cost.
///
///         WHAT THIS DOES NOT DO (be honest about this in any docs/pitch):
///          - It does NOT hide transactions from the Arbitrum sequencer itself.
///            The sequencer still sees and orders both the commit tx and the
///            reveal tx. Real mempool-level privacy requires a private
///            submission channel (Phase 3 in the roadmap) — this contract only
///            solves the "plaintext intent sitting in public state" problem
///            and the "predictable single-tx timing" problem.
///          - It is NOT a ZK proof system. No cryptographic proof of intent
///            validity is generated; correctness is enforced by the hash check
///            plus economic bonding, not by a SNARK/STARK.
///
///         WHY TIMESTAMP, NOT BLOCK NUMBER:
///          On Arbitrum, the `block.number` opcode read from inside a
///          contract reflects the L1 (Ethereum) block number, not the L2
///          sequencer block number that RPC calls like eth_blockNumber or a
///          transaction receipt's `blockNumber` return. Those two counters
///          move at completely different rates (L1 ~12s/block, L2 much
///          faster), so block-count based windows computed with
///          `block.number` do not line up with what off-chain tooling
///          observes. `block.timestamp` does not have this split — it's
///          consistent between what the contract sees and what any RPC
///          client sees — so all timing here is duration-based (seconds),
///          not block-count based. This was caught by testing the actual
///          deployed contract against Arbitrum Sepolia, not assumed.
///
///         PHASE 3 (PARTIAL): RELAYED REVEAL VIA EIP-712 SIGNATURE
///          `revealIntentViaRelay` lets an agent sign a reveal authorization
///          off-chain and have a DIFFERENT address (a relay) submit and pay
///          gas for the on-chain reveal transaction. This breaks the direct
///          link between "the wallet that committed the intent" and "the
///          wallet whose transaction executes it" as observed by anyone
///          watching the chain. It does NOT hide anything from the
///          Arbitrum sequencer (the reveal tx content is still fully
///          visible once submitted, same as `revealIntent`), and it does
///          NOT cover the commit step — only reveal. It is one deliberately
///          narrow piece of Phase 3, not the full private-relay roadmap
///          item. See README for what a production relay would still need
///          (a hosted always-on service, decentralization / anti-censorship
///          guarantees, rate limiting, etc.) that this repo does not provide.
///
///         PHASE 3 (PARTIAL, EXTENDED): RELAYED COMMIT
///          `commitIntentViaRelay` closes the gap noted above — an agent can
///          now sign a commit authorization off-chain too, so BOTH commit
///          and reveal can be submitted by a relay instead of the agent's
///          own wallet ever touching the chain directly. This narrows what
///          an on-chain observer can link to the agent's real wallet even
///          further, but it is still not sequencer-level privacy (see
///          above) and still assumes a relay is actually available.
///
///         EMERGENCY PAUSE (mainnet-readiness item, see README):
///          `guardian` can pause/unpause new commitments
///          (`commitIntent`/`commitIntentViaRelay`) via OpenZeppelin's
///          `Pausable`. Deliberately narrow: pausing blocks NEW exposure
///          from growing, but never blocks resolving what's already
///          committed — `revealIntent`, `revealIntentViaRelay`,
///          `withdrawBond`, and `slashNoReveal` all keep working while
///          paused, so an emergency stop can never trap an agent's already
///          -locked bond or already-committed intent. `guardian` is a
///          single immutable address for now — an intentional MVP
///          simplification, not a final design: a real mainnet deployment
///          should point it at a dedicated pause-multisig, not a single
///          EOA (and deliberately not at `AncillaTreasuryMultisig` either
///          — that contract is scoped to ETH custody only and has no
///          mechanism to call anything else, including this).
///
///         ECONOMIC HARDENING (mainnet-readiness item, see README):
///          `slashNoReveal` was already permissionless (anyone could call
///          it), but 100% of the penalty went to `treasury` — meaning
///          nobody but the protocol operator had any actual reason to
///          spend their own gas calling it, which in practice meant
///          slashing relied on someone remembering to do it, not on the
///          "permissionless" property doing real work. `slasherRewardBps`
///          fixes that by paying whoever calls `slashNoReveal` a cut of
///          the penalty (basis points out of 10,000) — the rest still
///          goes to `treasury`. Same pattern as liquidation bounties in
///          lending protocols: turn enforcement into something
///          profit-driven and decentralized instead of something that
///          depends on an operator noticing.
///
///          What this does NOT fix, and can't without breaking the
///          protocol's own point: bond is a flat amount, not scaled to
///          the notional value of what's being committed. At commit time
///          only a hash is on-chain — the contract has no way to know
///          (and must not reveal) whether an intent is worth $10 or
///          $1,000,000. For a large enough trade, `minBond` can be
///          smaller than the value an agent could gain from walking away
///          (forfeiting the bond) rather than executing an intent that
///          became unprofitable between commit and reveal. This is a
///          known, structural limitation of flat-bond commit-reveal, not
///          an oversight — see the README for the fuller writeup, and for
///          why fixing it properly is a mechanism-design question, not a
///          one-line patch.
contract IntentCommitReveal is Pausable {
    // ---------------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------------

    /// @notice Length of one commit epoch, in seconds.
    uint64 public immutable commitWindowSeconds;

    /// @notice Seconds to wait after an epoch's commit window closes before
    ///         reveals for that epoch are accepted. Gives every commitment in
    ///         the epoch the same starting line for reveal, instead of
    ///         whoever committed first also being able to reveal first.
    uint64 public immutable revealDelaySeconds;

    /// @notice How long the reveal window stays open once it starts.
    uint64 public immutable revealWindowSeconds;

    /// @notice Minimum bond an address must hold in this contract before it
    ///         is allowed to commit an intent.
    uint256 public immutable minBond;

    address public immutable treasury;

    /// @notice Can pause/unpause new commitments — see the header comment
    ///         for exactly what pausing does and doesn't do, and why this
    ///         is a single address for now.
    address public immutable guardian;

    /// @notice Share of a slashed penalty (basis points out of 10,000)
    ///         paid to whoever calls `slashNoReveal`, instead of the full
    ///         amount going to `treasury` — see the header comment.
    uint16 public immutable slasherRewardBps;

    // ---------------------------------------------------------------------
    // EIP-712 (relayed reveal signatures)
    // ---------------------------------------------------------------------

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public constant REVEAL_TYPEHASH = keccak256(
        "RevealRequest(bytes32 commitId,bytes32 intentDataHash,bytes32 salt,address executor,address agent,uint256 deadline)"
    );

    bytes32 public constant COMMIT_TYPEHASH = keccak256(
        "CommitRequest(bytes32 commitId,bytes32 commitHash,address agent,uint256 deadline)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // secp256k1 curve order, and half of it — used to reject the malleable
    // "high-s" form of a signature so each authorization has exactly one
    // valid encoding. HALF_N is derived from N via a constant expression
    // (computed by the compiler) rather than hand-typed a second time, after
    // a hand-typed copy of this constant was found to be wrong by one hex
    // digit during testing — see README "A real bug we hit and fixed".
    uint256 private constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant SECP256K1_HALF_N = SECP256K1_N / 2;

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    struct Commitment {
        bytes32 commitHash;
        address agent;
        uint64 epoch;
        bool revealed;
        bool slashed;
    }

    /// @dev commitId => Commitment
    mapping(bytes32 => Commitment) public commitments;

    /// @dev bond balance per agent, deposited via depositBond().
    mapping(address => uint256) public bondBalance;

    /// @dev sum of `minBond` reserved against this agent's currently
    ///      unresolved (not yet revealed or slashed) commitments. Funds up
    ///      to this amount cannot be withdrawn — see withdrawBond(). This
    ///      exists because an earlier version of this contract let an agent
    ///      commit, immediately withdraw its entire bond, and never reveal:
    ///      slashNoReveal() would then find bondBalance already at 0 and
    ///      slash nothing, defeating the whole point of requiring a bond.
    ///      Proven with a failing-by-design test before this fix existed —
    ///      see README "Bugs we hit and fixed".
    mapping(address => uint256) public lockedBond;

    event BondDeposited(address indexed agent, uint256 amount, uint256 newBalance);
    event BondWithdrawn(address indexed agent, uint256 amount, uint256 newBalance);
    /// @param relayer address(0) when the agent committed directly
    ///        (`commitIntent`); otherwise the relay that submitted on the
    ///        agent's behalf via `commitIntentViaRelay`.
    event IntentCommitted(bytes32 indexed commitId, address indexed agent, address relayer, uint64 epoch, uint64 revealOpenTime, uint64 revealCloseTime);
    /// @param relayer address(0) when the agent revealed directly (`revealIntent`);
    ///        otherwise the relay that submitted on the agent's behalf via
    ///        `revealIntentViaRelay`.
    event IntentRevealed(bytes32 indexed commitId, address indexed agent, address indexed executor, address relayer, bool success);
    /// @param totalPenalty the full amount forfeited by `agent` (unchanged
    ///        meaning from before the slasher-reward split existed).
    /// @param slasherReward the cut of `totalPenalty` paid to `slasher`;
    ///        `totalPenalty - slasherReward` went to `treasury`.
    event IntentSlashed(
        bytes32 indexed commitId, address indexed agent, uint256 totalPenalty, uint256 slasherReward, address slasher
    );

    error BondTooLow(uint256 have, uint256 need);
    error CommitAlreadyExists();
    error CommitNotFound();
    error AlreadyRevealed();
    error AlreadySlashed();
    error RevealNotOpenYet(uint64 opensAt);
    error RevealWindowClosed(uint64 closedAt);
    error HashMismatch();
    error StillInsideRevealWindow(uint64 closesAt);
    error InsufficientFreeBond();
    error SignatureExpired(uint256 deadline);
    error InvalidSignatureLength();
    error InvalidSignatureS();
    error InvalidSignatureV();
    error InvalidSigner();
    error NotGuardian();

    constructor(
        uint64 _commitWindowSeconds,
        uint64 _revealDelaySeconds,
        uint64 _revealWindowSeconds,
        uint256 _minBond,
        address _treasury,
        address _guardian,
        uint16 _slasherRewardBps
    ) {
        require(_commitWindowSeconds > 0, "commitWindow=0");
        require(_revealWindowSeconds > 0, "revealWindow=0");
        require(_treasury != address(0), "treasury=0");
        require(_guardian != address(0), "guardian=0");
        require(_slasherRewardBps <= 10_000, "slasherRewardBps>100%");
        commitWindowSeconds = _commitWindowSeconds;
        revealDelaySeconds = _revealDelaySeconds;
        revealWindowSeconds = _revealWindowSeconds;
        minBond = _minBond;
        treasury = _treasury;
        guardian = _guardian;
        slasherRewardBps = _slasherRewardBps;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Ancilla")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // Emergency pause — see the header comment for exactly what this does
    // and doesn't cover.
    // ---------------------------------------------------------------------

    function pause() external {
        if (msg.sender != guardian) revert NotGuardian();
        _pause();
    }

    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian();
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Bonding
    // ---------------------------------------------------------------------

    function depositBond() external payable {
        bondBalance[msg.sender] += msg.value;
        emit BondDeposited(msg.sender, msg.value, bondBalance[msg.sender]);
    }

    /// @notice Withdraw bond that isn't reserved against a pending
    ///         commitment and isn't needed to cover the minimum.
    function withdrawBond(uint256 amount) external {
        uint256 bal = bondBalance[msg.sender];
        if (bal < amount) revert InsufficientFreeBond();
        uint256 remaining = bal - amount;
        // Cannot withdraw funds reserved against unresolved commitments —
        // this is the fix for the bond-withdrawal-before-slash gap.
        if (remaining < lockedBond[msg.sender]) revert InsufficientFreeBond();
        if (remaining < minBond && remaining != 0) revert InsufficientFreeBond();
        bondBalance[msg.sender] = remaining;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "withdraw transfer failed");
        emit BondWithdrawn(msg.sender, amount, remaining);
    }

    // ---------------------------------------------------------------------
    // Epoch math (all in seconds, via block.timestamp)
    // ---------------------------------------------------------------------

    function currentEpoch() public view returns (uint64) {
        return uint64(block.timestamp) / commitWindowSeconds;
    }

    /// @notice Timestamp at which a given epoch's reveal window opens.
    function revealOpenTimeOf(uint64 epoch) public view returns (uint64) {
        return (epoch + 1) * commitWindowSeconds + revealDelaySeconds;
    }

    /// @notice Timestamp (exclusive) at which a given epoch's reveal window closes.
    function revealCloseTimeOf(uint64 epoch) public view returns (uint64) {
        return revealOpenTimeOf(epoch) + revealWindowSeconds;
    }

    // ---------------------------------------------------------------------
    // Commit
    // ---------------------------------------------------------------------

    /// @param commitId   caller-chosen unique id (e.g. keccak256(agent, nonce))
    ///                   so one agent can have multiple in-flight intents.
    /// @param commitHash keccak256(abi.encode(intentData, salt, msg.sender))
    function commitIntent(bytes32 commitId, bytes32 commitHash) external {
        _commit(commitId, commitHash, msg.sender, address(0));
    }

    /// @notice Same as `commitIntent`, but submitted by a relay on the
    ///         agent's behalf. `agent` must have signed an EIP-712
    ///         CommitRequest authorizing exactly this (commitId, commitHash,
    ///         deadline). Together with `revealIntentViaRelay`, this means
    ///         an agent's own wallet never has to submit a transaction to
    ///         this contract at all — everything can go through a relay.
    /// @dev Same permissionless design as `revealIntentViaRelay`: any holder
    ///      of a validly signed request can submit it, not just one
    ///      designated relay address.
    function commitIntentViaRelay(
        bytes32 commitId,
        bytes32 commitHash,
        address agent,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        bytes32 structHash = keccak256(abi.encode(COMMIT_TYPEHASH, commitId, commitHash, agent, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered != agent) revert InvalidSigner();

        _commit(commitId, commitHash, agent, msg.sender);
    }

    /// @dev Shared commit logic for both the self-submitted and relayed
    ///      paths. `authorizedAgent` is whose commitment/bond this is
    ///      checked and recorded against — already proven authentic by
    ///      either msg.sender equality in `commitIntent`, or a verified
    ///      signature in `commitIntentViaRelay`, before this is called.
    ///      `whenNotPaused` lives here, not on each public entrypoint
    ///      separately, so both paths are gated by one place — see the
    ///      header comment for why only new commits (not reveals,
    ///      withdrawals, or slashing) are ever blocked by a pause.
    function _commit(bytes32 commitId, bytes32 commitHash, address authorizedAgent, address relayer)
        internal
        whenNotPaused
    {
        // Must have enough UNLOCKED bond to cover this commitment on top of
        // whatever is already reserved against other pending ones — this is
        // what actually makes the bond function as collateral instead of a
        // one-time gate that can be withdrawn right after committing.
        uint256 needed = lockedBond[authorizedAgent] + minBond;
        if (bondBalance[authorizedAgent] < needed) revert BondTooLow(bondBalance[authorizedAgent], needed);
        if (commitments[commitId].agent != address(0)) revert CommitAlreadyExists();

        lockedBond[authorizedAgent] += minBond;

        uint64 epoch = currentEpoch();
        commitments[commitId] = Commitment({
            commitHash: commitHash,
            agent: authorizedAgent,
            epoch: epoch,
            revealed: false,
            slashed: false
        });

        emit IntentCommitted(commitId, authorizedAgent, relayer, epoch, revealOpenTimeOf(epoch), revealCloseTimeOf(epoch));
    }

    // ---------------------------------------------------------------------
    // Reveal
    // ---------------------------------------------------------------------

    /// @param commitId   id used at commit time
    /// @param intentData ABI-encoded payload forwarded to `executor`
    /// @param salt       random value used to build the original commitHash
    /// @param executor   contract that knows how to execute this intentData
    function revealIntent(
        bytes32 commitId,
        bytes calldata intentData,
        bytes32 salt,
        IIntentExecutor executor
    ) external returns (bool success) {
        return _reveal(commitId, intentData, salt, executor, msg.sender, address(0));
    }

    /// @notice Same as `revealIntent`, but submitted by a relay on the
    ///         agent's behalf. `agent` must have signed an EIP-712
    ///         RevealRequest authorizing exactly this (commitId, intentData,
    ///         salt, executor, deadline) — msg.sender (the relay) pays gas
    ///         and is recorded in the emitted event as `relayer`, but the
    ///         intent is still attributed and executed as `agent`.
    /// @dev Anyone holding a validly signed request may submit it — this is
    ///      deliberately permissionless, not restricted to one designated
    ///      relay address, so a single relay operator going offline can't by
    ///      itself block an agent's reveal (the agent, or any other relay,
    ///      can submit the same signed payload).
    function revealIntentViaRelay(
        bytes32 commitId,
        bytes calldata intentData,
        bytes32 salt,
        IIntentExecutor executor,
        address agent,
        uint256 deadline,
        bytes calldata signature
    ) external returns (bool success) {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        bytes32 structHash = keccak256(
            abi.encode(REVEAL_TYPEHASH, commitId, keccak256(intentData), salt, address(executor), agent, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, signature);
        if (recovered != agent) revert InvalidSigner();

        return _reveal(commitId, intentData, salt, executor, agent, msg.sender);
    }

    /// @dev Shared reveal logic for both the self-submitted and relayed paths.
    ///      `authorizedAgent` is the address whose commitment/bond this
    ///      reveal is checked against (already proven authentic by either
    ///      msg.sender equality in `revealIntent`, or a verified signature in
    ///      `revealIntentViaRelay`, before this is called).
    function _reveal(
        bytes32 commitId,
        bytes calldata intentData,
        bytes32 salt,
        IIntentExecutor executor,
        address authorizedAgent,
        address relayer
    ) internal returns (bool success) {
        Commitment storage c = commitments[commitId];
        if (c.agent == address(0)) revert CommitNotFound();
        if (c.agent != authorizedAgent) revert CommitNotFound();
        if (c.revealed) revert AlreadyRevealed();
        if (c.slashed) revert AlreadySlashed();

        uint64 openTime = revealOpenTimeOf(c.epoch);
        uint64 closeTime = revealCloseTimeOf(c.epoch);
        if (block.timestamp < openTime) revert RevealNotOpenYet(openTime);
        if (block.timestamp >= closeTime) revert RevealWindowClosed(closeTime);

        bytes32 expected = keccak256(abi.encode(intentData, salt, authorizedAgent));
        if (expected != c.commitHash) revert HashMismatch();

        c.revealed = true;
        lockedBond[authorizedAgent] -= minBond; // this commitment is resolved, release its reserved bond

        success = executor.executeIntent(authorizedAgent, intentData);
        emit IntentRevealed(commitId, authorizedAgent, address(executor), relayer, success);
    }

    /// @dev Minimal ECDSA recovery (r,s,v split) with malleability
    ///      protection (rejects high-s signatures), equivalent in behaviour
    ///      to OpenZeppelin's ECDSA.recover but implemented directly here so
    ///      this repo has no external dependency to audit alongside it.
    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r;
        bytes32 s;
        uint8 v;
        // Reading r/s/v directly out of calldata via assembly is the
        // standard, unambiguous way to do this (same approach used by
        // OpenZeppelin's ECDSA library) — avoids any doubt about how a
        // `bytes calldata` slice-to-`bytes32` cast is encoded.
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (uint256(s) > SECP256K1_HALF_N) revert InvalidSignatureS();
        if (v != 27 && v != 28) revert InvalidSignatureV();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSigner();
        return signer;
    }

    // ---------------------------------------------------------------------
    // Slashing — punishes commit-and-vanish behaviour that would otherwise
    // let an agent spam commitments to pollute batch timing for free.
    // ---------------------------------------------------------------------

    function slashNoReveal(bytes32 commitId) external {
        Commitment storage c = commitments[commitId];
        if (c.agent == address(0)) revert CommitNotFound();
        if (c.revealed) revert AlreadyRevealed();
        if (c.slashed) revert AlreadySlashed();

        uint64 closeTime = revealCloseTimeOf(c.epoch);
        if (block.timestamp < closeTime) revert StillInsideRevealWindow(closeTime);

        c.slashed = true;
        lockedBond[c.agent] -= minBond; // release this commitment's reservation regardless of payout below

        uint256 penalty = minBond;
        uint256 bal = bondBalance[c.agent];
        // With bond now locked at commit time, `bal` should always be >=
        // minBond here for this specific commitment's share — this min() is
        // kept as defense-in-depth, not because it's expected to trigger.
        if (penalty > bal) penalty = bal;
        bondBalance[c.agent] = bal - penalty;

        uint256 reward = (penalty * slasherRewardBps) / 10_000;
        uint256 toTreasury = penalty - reward;

        if (toTreasury > 0) {
            (bool okTreasury, ) = treasury.call{value: toTreasury}("");
            require(okTreasury, "slash transfer failed");
        }
        if (reward > 0) {
            (bool okReward, ) = msg.sender.call{value: reward}("");
            require(okReward, "slasher reward transfer failed");
        }

        emit IntentSlashed(commitId, c.agent, penalty, reward, msg.sender);
    }
}
