# Ancilla

[![CI](https://github.com/ANCILLA-ARB/ancilla/actions/workflows/ci.yml/badge.svg)](https://github.com/ANCILLA-ARB/ancilla/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?logo=solidity&logoColor=white)](contracts/IntentCommitReveal.sol)
[![Network](https://img.shields.io/badge/Arbitrum-Sepolia_testnet-28A0F0?logo=arbitrum&logoColor=white)](https://sepolia.arbiscan.io/address/0x52e7928BD70FcA210B939cd0116EA3F9e043014d)

> *ancilla* (Latin) — a trusted attendant who carries out a task on someone's
> behalf. That's the whole pitch: a privacy layer for AI agents that act for
> you on Arbitrum, without broadcasting exactly what they're about to do.

Commit-reveal + timing-batching privacy primitive for AI-agent transaction
intents on Arbitrum. This is **Phase 1 + 2 (full), Phase 3 (both commit and
reveal relayable at the contract level + a working relay-server prototype;
hosting/decentralization still not done)** of the phased plan (see
"Roadmap" below) — a real, tested, deployable smart contract, not a pitch
deck.

## Contents

- [What actually exists right now](#what-actually-exists-right-now-verified-not-claimed)
- [What this does NOT do](#what-this-does-not-do-read-this-before-pitching-it-to-anyone)
- [Roadmap](#roadmap-from-the-earlier-discussion-for-context)
- [Mainnet readiness](#mainnet-readiness) — what's done, what isn't, before this touches real value
- [Deploying to Arbitrum Sepolia](#deploying-to-arbitrum-sepolia-testnet)
- [Uniswap v4 hook architecture](#uniswap-v4-hook-architecture-option-a) — a second, parallel architecture gating a real Uniswap v4 pool instead of the standalone AMM, proven live
- [Contract parameters explained](#contract-parameters-explained)
- [Bugs we hit and fixed](#a-real-bug-we-hit-and-fixed-kept-here-on-purpose-not-swept-under-the-rug) — 7 real ones, kept on the record, not cleaned up out of the story
- [Project quality tooling](#project-quality-tooling) — coverage, gas, CI
- [License](#license)

## What actually exists right now (verified, not claimed)

- [`contracts/IntentCommitReveal.sol`](contracts/IntentCommitReveal.sol) —
  the core contract. Agents commit a hash of their intent, then reveal it
  only inside a shared batch window so many agents' intents surface together
  instead of one at a time. Includes an emergency pause (OpenZeppelin
  `Pausable`, guardian-only) scoped to block only *new* commitments —
  reveals, withdrawals, and slashing all keep working while paused, so a
  pause can never trap an agent's already-locked bond. **Proven live on
  Arbitrum Sepolia**, both halves: a new commit rejected while paused, and
  a pre-pause commitment still resolved successfully while still paused —
  see "Currently live" below. Also pays whoever calls `slashNoReveal` a
  configurable reward (`slasherRewardBps`, 10% by default) instead of
  sending the whole penalty to `treasury` — turns a permissionless-but-
  unrewarded function into one people actually have a reason to call.
  **Proven live** too — see "Mainnet readiness" for the full writeup.
- [`contracts/IIntentExecutor.sol`](contracts/IIntentExecutor.sol) — the
  interface any real protocol (DEX router, vault, etc.) implements to accept
  a revealed intent.
- [`contracts/mocks/MockExecutor.sol`](contracts/mocks/MockExecutor.sol) —
  a stand-in executor used only by tests.
- **[`contracts/AncillaSwapPool.sol`](contracts/AncillaSwapPool.sol) +
  [`contracts/SwapExecutor.sol`](contracts/SwapExecutor.sol)** — the first
  *real* (non-mock) `IIntentExecutor`. `AncillaSwapPool` is a minimal
  constant-product (Uniswap V2-style) AMM for one token pair;
  `SwapExecutor` bridges a revealed intent to an actual swap against it.
  This is what makes the project's core narrative — a privacy-preserving
  DeFi swap intent — demonstrable end-to-end instead of stopping at "the
  hash matched": commit a swap privately → reveal inside a shared batch
  window → **a real swap executes**, with real constant-product-formula
  output, verified against an independently-computed expected value, not
  just "the contract agrees with itself." **Proven live on Arbitrum
  Sepolia** (`npm run demo-swap:sepolia`, [`scripts/demo-swap.ts`](scripts/demo-swap.ts))
  — not just in `hardhat test` — see "Currently live on Arbitrum Sepolia"
  below for the deployed addresses and tx links. See the header comments on
  both files for the deliberate simplifications (no LP tokens, single pair,
  no MEV protection on the swap price itself — only on when/who submits the
  reveal).
- **[`contracts/AncillaTreasuryMultisig.sol`](contracts/AncillaTreasuryMultisig.sol)**
  — a minimal M-of-N multisig, built to close the single biggest mainnet
  blocker called out below: `IntentCommitReveal.treasury` is `immutable`,
  and every deployment so far has pointed it at one EOA — meaning one lost
  or compromised key would permanently own every slashed bond, forever,
  with no way to fix it after the fact. This contract requires a
  configurable threshold of owners to confirm a withdrawal before any ETH
  moves. Deliberately scoped to ETH custody + withdrawal approval only (no
  arbitrary call execution, no owner rotation) to keep it small enough to
  reason about directly. **Proven live on Arbitrum Sepolia**
  (`npm run demo-treasury:sepolia`, [`scripts/demo-treasury.ts`](scripts/demo-treasury.ts))
  — funded, a withdrawal proposed, confirmed rejected with only 1 of 2
  required confirmations, then executed for the exact amount once the
  second owner confirmed. **Not yet wired into a live `IntentCommitReveal`
  deployment** — that only happens on `IntentCommitReveal`'s *next*
  deployment, by pointing `treasury` at this contract's address instead of
  an EOA; the currently-live `IntentCommitReveal` above still uses an EOA
  treasury, unchanged, since `treasury` can't be edited after deployment.
  See "Mainnet readiness" below.
- **[`contracts/AncillaSwapHook.sol`](contracts/AncillaSwapHook.sol)** — a
  second, parallel architecture ("Option A"): a real Uniswap v4 hook that
  absorbs commit-reveal entirely, gating access to a genuine Uniswap v4
  pool instead of the standalone `AncillaSwapPool`. `IntentCommitReveal` is
  untouched by this — it's a parallel path, not a replacement. Has the
  identical emergency-pause mechanism as `IntentCommitReveal` (guardian-only,
  blocks new `commitIntent` calls only — `revealAndSwap` keeps working
  while paused) and the identical slasher-reward mechanism. **Proven live
  on Arbitrum Sepolia**, against Uniswap's
  actual, already-deployed `PoolManager` — see "Uniswap v4 hook
  architecture" below for the full design writeup, and "Currently live"
  for addresses and tx proof.
- [`sdk/intent.ts`](sdk/intent.ts) — the off-chain helper an agent operator
  calls to build a commitment (hash) before submitting `commitIntent()`.
- **`revealIntentViaRelay(...)` and `commitIntentViaRelay(...)`** in the same
  contract — an agent signs an EIP-712 authorization off-chain, and a
  *different* address (a relay) submits the transaction and pays its gas.
  The contract verifies the signature and still attributes the
  commit/reveal to the agent. Together, an agent's own wallet never has to
  submit a transaction to this contract at all. This breaks the on-chain
  link between "who committed/revealed" and "whose transaction did it" —
  it does **not** hide anything from the Arbitrum sequencer (see "What
  this does NOT do").
- [`sdk/relay.ts`](sdk/relay.ts) — builds and signs the EIP-712 authorization
  requests an agent hands to a relay, for both commit and reveal.
- [`relay-server/`](relay-server/) — a real, runnable HTTP server prototype
  implementing the relay side: agents POST signed requests, it submits them
  and (for reveals) polls until the window opens, with its queue persisted
  to disk so a restart doesn't drop pending work. **Not yet** a hosted
  24/7 service — Docker + Fly.io/Railway deployment config now exists and
  the compiled binary is proven to work (see
  [`relay-server/DEPLOYMENT.md`](relay-server/DEPLOYMENT.md)), but nobody
  has actually deployed an instance anywhere yet, deliberately left as the
  project owner's call — see [`relay-server/README.md`](relay-server/README.md)
  for exactly what it is and isn't, and 5 more real bugs found building it.
  Proven end-to-end via `npm run relay-server:e2e` (single relay, over
  HTTP) and `npm run relay-server:multi-e2e` (two independent relay
  instances given the same signed reveal — kills one mid-flight and
  confirms the other completes it anyway, since both relay functions are
  permissionless by design).
- [`test/IntentCommitReveal.test.ts`](test/IntentCommitReveal.test.ts) — **46
  tests** (including an "emergency pause" suite: guardian-only pause/unpause,
  new commits blocked while paused, and — the important one — resolving a
  commitment made *before* the pause still works *while still paused*; and
  slasher-reward coverage: the correct 10%/90% split, a 0%-reward
  deployment sending the full penalty to treasury, and a deliberate
  reentrancy attack from a malicious slasher trying to double-claim its
  own reward),
  [`test/relay-server.test.ts`](test/relay-server.test.ts) — **10
  more** (testing the relay-server's Express app in-process with
  `supertest` — previously zero automated coverage there), and
  [`test/SwapExecutor.test.ts`](test/SwapExecutor.test.ts) — **20 more**
  covering the pool's AMM math, the executor, a deliberate reentrancy
  attack against the pool (via a purpose-built hook-having token — plain
  ERC20 has no hooks to exploit), and the full private-swap-intent
  narrative end-to-end, and
  [`test/AncillaTreasuryMultisig.test.ts`](test/AncillaTreasuryMultisig.test.ts)
  — **25 more** covering the multisig's own constructor validation,
  propose/confirm/revoke/execute lifecycle, threshold enforcement, a
  failed-transfer case that proves a bad withdrawal reverts fully instead
  of getting stuck half-executed, and a deliberate reentrancy attack from
  a malicious withdrawal recipient that is also a listed owner, and
  [`test/AncillaSwapHook.test.ts`](test/AncillaSwapHook.test.ts) — **24
  more** covering the v4 hook stack: mining a real CREATE2 hook address,
  bonding, a full commit → reveal-and-swap cycle against a real locally
  deployed `PoolManager` in both swap directions, every rejection path the
  hook is actually supposed to enforce (early/late reveal, hash mismatch,
  wrong token/direction/amount, slippage, replay), and the identical
  emergency-pause behavior ported from `IntentCommitReveal`, and
  [`test/AncillaGuardianMultisig.test.ts`](test/AncillaGuardianMultisig.test.ts)
  — **23 more** covering the M-of-N multisig that now gates pause/unpause
  on both contracts, including a live-target integration test (a real
  `IntentCommitReveal` instance actually pausing/unpausing through it, not
  a mock) and a test proving a single confirmation is provably not enough
  to execute. **148 tests total, all passing** (re-run 3x
  consecutively to rule out flakiness). 100% statement/line/function
  coverage, 94%+ branch coverage on every core contract except the two v4
  router contracts (`npm run coverage`
  — remaining gaps are documented, not hidden — see "Bugs we hit and
  fixed"). Covers: constructor input validation, bond requirement and
  bond-locking (see "Third bug"
  below), full commit→reveal→execute flow,
  hash-mismatch rejection, reveal-window enforcement, no-reveal slashing
  (including against a commitment that was never committed, or already
  resolved), the batching property, both relay paths — commit and reveal
  (valid relayed submission, wrong-signer/malformed-signature/invalid-v/
  non-canonical-signature rejection, expired-signature rejection, replay
  rejection, and commit+reveal composing correctly together),
  `withdrawBond` (full withdrawal, over-withdrawal, stranded-dust
  rejection, and a failed-ETH-transfer case using a contract that refuses
  to receive ETH), unauthorized-reveal rejection (Bob can't reveal Alice's
  commitment), double-commit rejection, the executor-returns-failure path,
  three deliberate reentrancy attacks using real malicious mock contracts
  (`contracts/mocks/ReentrantAttacker.sol`, `contracts/mocks/MaliciousExecutor.sol`,
  `contracts/mocks/ReentrantToken.sol`), and the AMM pool's constant-product
  math verified against an independently-computed expected value in every
  swap test, not just "the contract agrees with itself."

Run it yourself:

```bash
npm install
npm run compile
npm test              # 148 tests (46 + 10 relay-server + 20 swap executor + 25 treasury multisig + 24 v4 hook + 23 guardian multisig)
npm run coverage      # statement/branch/function/line coverage report
npm run gas-report    # per-function gas cost table
npm run size          # deployed bytecode size vs the 24KB EIP-170 limit
```

## What this does NOT do (read this before pitching it to anyone)

- **It does not hide anything from the Arbitrum sequencer.** The sequencer
  still sees and orders every transaction here — commit, reveal, relayed
  commit, relayed reveal — in plaintext. The relay paths change *who
  submits* the transaction, not *whether* the sequencer/any RPC observer
  can see its content once submitted. A real private submission channel
  (hiding content from the sequencer/observers before inclusion) is not
  built.
- **The relay-server prototype is real code, but not a hosted service.**
  [`relay-server/`](relay-server/) is a working Node/Express server, proven
  end-to-end over HTTP (`npm run relay-server:e2e`) — but running it means
  starting a local process yourself. There is no deployment to a VPS/cloud
  host, no TLS, no auth/rate-limiting. Its pending-reveal queue **is**
  persisted to disk now (survives a restart), and because both relay
  functions are permissionless, an agent can submit the same signed
  request to *multiple* relay instances — proven live by killing one
  mid-flight and watching the other complete the reveal anyway
  (`npm run relay-server:multi-e2e`, see
  [`relay-server/README.md`](relay-server/README.md)). What's still
  missing: actual hosting (this tolerates a relay dying, it doesn't keep
  one alive on the public internet), and any relay discovery/reputation
  system — an agent still has to already know about and trust whichever
  relay endpoints it submits to. An agent can always fall back to calling
  `revealIntent`/`commitIntent` directly with their own wallet if every
  relay it knows about is unavailable — the relay is an optional
  convenience/privacy layer, not something the protocol depends on to
  function.
- **It is not a ZK proof system.** No SNARK/STARK is generated. Correctness
  is enforced by a hash check plus an economic bond, not by cryptographic
  proof. If you want to market this as "zero-knowledge," you'd be
  overclaiming — be precise and call it what it is: commit-reveal + batching.
- **The bond/slashing model is intentionally simple (MVP-grade).** Bond is
  now locked per-commitment (see "Third bug" below) so it can't be
  withdrawn out from under a pending reveal, but it's still a flat amount
  per commitment, not a stake-weighted or reputation-scaled system. The
  single-EOA-treasury gap is now closed at the contract level —
  [`AncillaTreasuryMultisig`](contracts/AncillaTreasuryMultisig.sol) exists
  and is proven live (see above) — but the *currently deployed*
  `IntentCommitReveal` on Sepolia still points `treasury` at an EOA,
  because that field is immutable and can only be set correctly on a fresh
  deployment. See "Mainnet readiness" below for exactly what's done and
  what isn't yet.
- **No third-party security audit has been done — deliberately deferred,
  not forgotten.** The current plan is to keep building and hardening the
  remaining mainnet-readiness items first (see below) and treat a
  professional audit as the final gate before any deployment that holds
  real value, rather than auditing code that's still actively changing.
  Everything in this repo is self-reviewed in the meantime: 148 unit tests,
  100% line coverage / 94%+ branch
  coverage on the core contract, three live testnet demos plus a local
  relay-server E2E run, and two deliberate self-attack tests (reentrancy
  against `withdrawBond` and against the executor-callback path — both
  currently blocked, proven with actual malicious mock contracts in
  `contracts/mocks/`, not just reasoned about). Self-review has already
  caught real bugs in this repo — including one genuine economic-security
  gap, not just a code bug (see "Bugs we hit and fixed" below) — and will
  keep missing things a professional audit would catch. Do not treat this
  as audited.
- **Randomness for batching isn't adversarially hardened yet.** Epoch
  boundaries are pure `block.timestamp` math, not a VRF. A sequencer or
  sufficiently privileged actor could in principle bias timestamps within
  Ethereum's allowed drift. Fine for an MVP; not fine for a production
  security claim.

## Roadmap (from the earlier discussion, for context)

| Phase | Status |
|---|---|
| 1 — Timing obfuscation (batched reveal windows) | ✅ built & tested here |
| 2 — Commit-reveal for intents | ✅ built & tested here |
| 3 — Private RPC / relay so commits+reveals don't sit in the public mempool at all | 🟡 **partial**: both `commitIntentViaRelay` and `revealIntentViaRelay` (EIP-712 meta-tx) let a relay submit on the agent's behalf, breaking the agent↔tx-sender link — proven live on testnet (commit+reveal separately) and end-to-end through a real relay-server prototype over HTTP (locally), including surviving one relay instance being killed mid-flight (multi-relay redundancy, proven via `npm run relay-server:multi-e2e`). Still missing: a *hosted*, always-on relay deployment (not just runnable locally), and relay operator discovery/reputation (agents still have to already know which relay endpoints to trust) — see [`relay-server/README.md`](relay-server/README.md). |
| 4 — "Refereed dual-node execution" (as originally scoped: cross-checking non-deterministic AI computation) | ⚪️ **doesn't apply to this architecture** — Ancilla's reveal step is fully deterministic (hash-bound at commit time via `keccak256(intentData, salt, agent) == commitHash`), so there's no non-deterministic computation inside the protocol for two nodes to disagree about and referee. Building a "referee" system here anyway would be feature theater, not a real fix. Multi-relay redundancy (row above) is the honest analog: it addresses the actual failure mode (one relay operator going down/censoring), not a fabricated one. |
| 5 — Actual ZK proof of correct execution | ❌ research-stage, not committed to |

## Mainnet readiness

This is separate from the phase roadmap above — the phases are about
*feature scope*; this is about what's needed before any deployment holds
real value, not testnet ETH. Decided approach: build and harden the remaining items first, treat a
third-party audit as the final gate right before a real deployment, not
something to run against code that's still changing.

| Item | Status |
|---|---|
| Treasury as a multisig, not a single EOA | ✅ **wired into the live `IntentCommitReveal`, not just deployed standalone.** [`AncillaTreasuryMultisig`](contracts/AncillaTreasuryMultisig.sol), 25 tests (including a deliberate reentrancy attack), **proven live on Sepolia** two ways: a withdrawal correctly rejected with 1/2 confirmations then executed with 2/2 (`npm run demo-treasury:sepolia`), and — against the current deployment specifically — a real slash landing in it as `treasury` (`npm run demo-slasher-reward:sepolia`, see the tx links above). Getting `treasury` from an EOA into this multisig required a full `IntentCommitReveal` redeploy, since the field is `immutable`; `scripts/deploy.ts` now refuses to run at all unless a treasury multisig already exists in `deployments/<network>.json`, closing off the silent-EOA-default path for good. |
| Emergency pause / circuit breaker | ✅ **guardian is now a 2-of-3 [`AncillaGuardianMultisig`](contracts/AncillaGuardianMultisig.sol), not a single EOA, on the live `IntentCommitReveal`.** Both `IntentCommitReveal` and `AncillaSwapHook` have a guardian-gated pause (OpenZeppelin `Pausable`) scoped to block only *new* commitments — reveals, withdrawals, and slashing keep working while paused, so a pause can never trap an agent's already-locked bond. 23 new tests for the multisig itself (including a live-target integration test and a single-confirmation-must-fail test), **proven live on Sepolia** (`npm run demo-guardian-multisig:sepolia`) — a solo `execute()` attempt with 1 confirmation genuinely reverts, a second independent owner's confirmation is required before pause *or* unpause goes through, and the underlying pause semantics (new commit rejected, pre-pause reveal still works while paused) hold throughout. `AncillaSwapHook`'s `guardian` is still a single EOA — a known, tracked gap; redeploying the hook to fix it also requires re-mining its CREATE2 address and re-initializing its pool/liquidity, deliberately not bundled into this pass. |
| Economic model hardening (bond/slashing) | 🟡 **partial, by design.** `slashNoReveal` was already permissionless but paid its caller nothing — 100% went to `treasury`, meaning in practice only the operator had any reason to call it. `slasherRewardBps` (10% default) now pays whoever calls it, turning enforcement into a permissionless, profit-driven bounty instead of something that depends on an operator noticing — same pattern as lending-protocol liquidation bounties. **Proven live** (`npm run demo-slasher-reward:sepolia`) — an unrelated third-party wallet earned the exact expected 10% reward, gas-cost-adjusted, for slashing a ghosted commitment. **What's still NOT fixed, and can't be without breaking the protocol's own point:** bond is a flat amount, not scaled to trade notional — at commit time only a hash is on-chain, so the contract can't know (and must not reveal) whether an intent is worth $10 or $1,000,000. For a large enough trade, `minBond` can be smaller than the value an agent gains by walking away (forfeiting the bond) rather than executing an intent that became unprofitable between commit and reveal. This is a structural limitation of flat-bond commit-reveal, not an oversight — see `IntentCommitReveal.sol`'s header comment for the fuller reasoning. |
| Batching randomness | ⚪️ **deliberately deferred, not started.** `block.timestamp`-based epochs are fine for an MVP; not adversarially hardened against a sequencer biasing timestamps within Ethereum's allowed drift. Fixing this properly means a VRF (e.g. Chainlink VRF) — a real external-oracle dependency, ongoing subscription/LINK cost, and new trust assumptions, for a drift window measured in seconds against an attack that requires an already-compromised or colluding sequencer. Deferring this is a scope call, not an oversight: building VRF integration now, before the items above it, would be solving a smaller, lower-likelihood problem before larger ones — the same "don't build feature theater" reasoning already applied to Phase 4 in the roadmap above. |
| Relay-server hosting | ✅ **deployed and proven live, publicly, over real HTTPS.** [`relay-server/Dockerfile`](relay-server/Dockerfile) is hosted on Railway; `scripts/relay-server-live-e2e.ts` ran the full commit → HTTP POST → reveal → on-chain-confirm cycle against that real public URL (not a local process) — [commit tx](https://sepolia.arbiscan.io/tx/0x1f4286c0bd0b7f500ce110812aa22b7c53aa72ad1cc4e97412b30ef2a4155342), [reveal tx](https://sepolia.arbiscan.io/tx/0xa830f4107086c9171013df4565fda25f7ef7ff35b0c3e85e3e8d3a0623e4984e). Getting there surfaced and fixed three real deploy-only bugs no test caught: `ethers`/`dotenv` misclassified as dev-only dependencies (would've broken a production-only install), Railway's dynamically-assigned `PORT` not being read (healthcheck failure), and a queue-file `ENOENT` crash on `/reveal` from a directory assumption that only held locally, not inside the Docker image (see [`relay-server/DEPLOYMENT.md`](relay-server/DEPLOYMENT.md) and [`relay-server/README.md`](relay-server/README.md) for the full list). Non-blocking regardless of hosting status: the protocol never depends on the relay — an agent can always call `commitIntent`/`revealIntent` directly. **⚠️ Currently stale:** the hosted Railway instance's `RELAY_CONTRACT_ADDRESS` still points at the *previous* `IntentCommitReveal` deployment (the one used for that live E2E proof), not the current one above — `IntentCommitReveal` was redeployed afterward to wire in the treasury/guardian multisigs (see "Mainnet readiness"). The old deployment still works fine on-chain, so the hosted relay isn't broken, just pointed at a superseded contract; updating Railway's environment variable to the new address is a manual dashboard step, deliberately left to whoever holds that Railway account rather than something an agent should do unilaterally. |
| Third-party security audit | ⏳ **deliberately deferred to the end, by design** — not skipped, not forgotten. |

## Deploying to Arbitrum Sepolia (testnet)

```bash
cp .env.example .env
# fill in PRIVATE_KEY (and AGENT_PRIVATE_KEY, for the relay demos — see
# .env.example for what each is for) with testnet-only keys, plus
# optionally a dedicated RPC URL
npm run deploy:sepolia
```

Get Arbitrum Sepolia test ETH from the [Arbitrum faucet](https://faucet.quicknode.com/arbitrum/sepolia)
before deploying.

`deploy.ts` writes the result to
[`deployments/arbitrumSepolia.json`](deployments/arbitrumSepolia.json) —
the single source of truth every demo script (`demo.ts`, `demo-relay.ts`,
`demo-bond-lock.ts`) reads the live contract address from, instead of each
hardcoding its own copy. (An earlier version of this repo had exactly that
problem: three demo scripts, three different hardcoded addresses, two of
them stale — caught and fixed in a cleanup pass, not before.)

### Currently live on Arbitrum Sepolia

| Contract | Address |
|---|---|
| `IntentCommitReveal` (relay support, bond locking, emergency pause) | [`0x52e7928BD70FcA210B939cd0116EA3F9e043014d`](https://sepolia.arbiscan.io/address/0x52e7928BD70FcA210B939cd0116EA3F9e043014d) |
| `TestTokenA` (aUSD, mintable test ERC20) | [`0xCf7fC3b5A96cc8ef46D558fB455B63ec862ba977`](https://sepolia.arbiscan.io/address/0xCf7fC3b5A96cc8ef46D558fB455B63ec862ba977) |
| `TestTokenB` (aETH, mintable test ERC20) | [`0x9487f45a0fEf6C96d1571Ae7B32f020995710f73`](https://sepolia.arbiscan.io/address/0x9487f45a0fEf6C96d1571Ae7B32f020995710f73) |
| `AncillaSwapPool` (constant-product AMM, aUSD/aETH) | [`0x3663a10bB68cEbe477843673385d5D97ea12cb0b`](https://sepolia.arbiscan.io/address/0x3663a10bB68cEbe477843673385d5D97ea12cb0b) |
| `SwapExecutor` (real `IIntentExecutor`) | [`0x10896dDf2e5D5E9fbc2Eb3dd2C65719A86aaDc76`](https://sepolia.arbiscan.io/address/0x10896dDf2e5D5E9fbc2Eb3dd2C65719A86aaDc76) |
| `AncillaTreasuryMultisig` (2-of-3, now actually wired into `IntentCommitReveal.treasury` above — see "Mainnet readiness") | [`0xC5d4f69B53520DC5a625BA8197176E053C845800`](https://sepolia.arbiscan.io/address/0xC5d4f69B53520DC5a625BA8197176E053C845800) |
| `AncillaGuardianMultisig` (2-of-3, wired into `IntentCommitReveal.guardian` above — see "Mainnet readiness") | [`0x26E1A66E96296125c5C04fB90c64D167e27694c1`](https://sepolia.arbiscan.io/address/0x26E1A66E96296125c5C04fB90c64D167e27694c1) |
| `AncillaSwapHook` ("Option A" v4 architecture, emergency pause) | [`0xCAa8DAB78aa73425eADd87b91f3310cB0e5140C0`](https://sepolia.arbiscan.io/address/0xCAa8DAB78aa73425eADd87b91f3310cB0e5140C0) |
| `AncillaHookRouter` | [`0x7FD0cDD9694bF7460E758144610d14fb5E21c4e6`](https://sepolia.arbiscan.io/address/0x7FD0cDD9694bF7460E758144610d14fb5E21c4e6) |
| `AncillaLiquidityRouter` | [`0xDfDa97d9d7Dd0e17324a2BD1913dd28d43486d7E`](https://sepolia.arbiscan.io/address/0xDfDa97d9d7Dd0e17324a2BD1913dd28d43486d7E) |
| Uniswap v4 `PoolManager` (Uniswap's, not ours) | [`0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317`](https://sepolia.arbiscan.io/address/0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317) |

`IntentCommitReveal` deployed with `commitWindowSeconds=120`,
`revealDelaySeconds=30`, `revealWindowSeconds=120`, `minBond=0.001 ETH`,
`treasury=AncillaTreasuryMultisig` (2-of-3), `guardian=AncillaGuardianMultisig`
(2-of-3), `slasherRewardBps=1000` (10%, see "Mainnet readiness" below for
the full economic-hardening writeup). Both governance addresses above are
now real multisigs, not EOAs — `scripts/deploy.ts` itself enforces this:
it reads both from `deployments/arbitrumSepolia.json` and throws rather
than silently falling back to `deployer.address` if either multisig
hasn't been deployed first. `AncillaSwapHook`'s `guardian` is still a
single EOA as of this deployment — a known, tracked gap, not an oversight
(redeploying the hook also requires re-mining its CREATE2 address and
re-initializing its pool/liquidity, deliberately not bundled into this
pass). Source is
not yet verified on Arbiscan (no API key configured) — the contract works regardless, just without human-readable
source in the explorer UI. Verify it yourself with
`npx hardhat verify --network arbitrumSepolia <address> 120 30 120 1000000000000000 <treasury> <guardian> 1000`
once you set `ARBISCAN_API_KEY` in `.env`.

This is the **sixth** deployment of `IntentCommitReveal` — redeployed
again to wire `treasury`/`guardian` to the two multisigs above instead of
a single EOA — and the **third** of `AncillaSwapHook` (unchanged this
round). Being precise about what's actually been
re-proven against *these exact* addresses, instead of implying everything
carried over automatically just because the source code did:

- **Slasher reward** (`npm run demo-slasher-reward:sepolia`, [`scripts/demo-slasher-reward.ts`](scripts/demo-slasher-reward.ts))
  — the actual new economic-hardening behavior, proven live: one wallet
  commits and deliberately never reveals; once the reveal window closes,
  a completely unrelated second wallet calls `slashNoReveal` and is paid
  a real reward for doing so, instead of the whole penalty vanishing into
  the treasury with nothing in it for whoever bothered to enforce the
  rule. Re-verified independently against **this exact deployment**,
  gas-cost-adjusted: `AncillaTreasuryMultisig` — a real multisig contract
  now, not an EOA — received exactly 90% of the `0.001 ETH` penalty, the
  slasher's balance increased by exactly the other 10% net of its own gas
  cost. Example tx:
  [commit (the ghosted intent)](https://sepolia.arbiscan.io/tx/0xe84be7682ae52d920510be44dbcefcae749ce158204eebc31508522f623c1c71),
  [slashNoReveal (called by the unrelated wallet)](https://sepolia.arbiscan.io/tx/0x81e6a93ac683cdeb930d0f54d7bf453e81ac9b60ec7a5ab24e772e12d65545cd).
  See "Mainnet readiness" below for the full writeup, including what this
  does *not* fix.
- **Real swap execution** (`npm run demo-swap:sepolia`,
  [`scripts/demo-swap.ts`](scripts/demo-swap.ts)) — re-verified live
  against **this exact deployment**. Seeds pool liquidity, mints the agent
  1000 aUSD, quotes the expected output via `pool.getAmountOut()` *before*
  committing, commits the swap intent (on-chain, only the hash visible),
  waits out the real batch reveal window, then reveals — which is the
  moment `SwapExecutor` pulls the aUSD, calls `pool.swap()`, and sends
  aETH back to the agent. Verified independently afterward via balance
  **delta**, not an absolute balance (see "Seventh" bug below for why):
  exactly 1000 aUSD spent, exactly the quoted `0.465420437072675898` aETH
  received. Example tx:
  [commit](https://sepolia.arbiscan.io/tx/0xedc2764d425a35e5bb6e74f3979c5c2163d52f9f8f3cd40a8285b8b3be4f624d),
  [reveal + real swap](https://sepolia.arbiscan.io/tx/0xb8574058bad653a7f9577de6a638f77f95e5866def3a8af91aaf11d3dcfa5332).
- **The v4 hook stack** (`npm run deploy-hook:sepolia`,
  `npm run demo-hook-swap:sepolia`, [`scripts/demo-hook-swap.ts`](scripts/demo-hook-swap.ts))
  — re-verified live against **this exact deployment** and Uniswap's real,
  already-deployed `PoolManager`, not a locally-deployed stand-in. Agent
  bonds, commits an intent, waits out the real batch window, then calls
  `AncillaHookRouter.revealAndSwap` — a single transaction in which
  `AncillaSwapHook`'s `beforeSwap` verifies the hash commitment, the
  timing window, and that the swap's real token/direction/amount match
  what was committed to, the real v4 swap then executes against real
  pooled liquidity, and `afterSwap` enforces the committed `minAmountOut`
  against the actual output. Verified independently afterward via balance
  **delta**: exactly the committed `amountIn` moved out, output balance
  increased, `commitments(commitId).revealed` flipped true, one
  `IntentSwapExecuted` event. Example tx:
  [commit](https://sepolia.arbiscan.io/tx/0xd530a738b5c59d18ce3708e653b6680530188167007d86c0956f638909747971),
  [reveal-and-swap](https://sepolia.arbiscan.io/tx/0xadf46f154e782aa089357dd5beb2c8f87707a6b6f3736da8baa3c5fc62f837fd).
  See "Uniswap v4 hook architecture" below for the full design writeup.
- **Emergency pause, now governed by a 2-of-3 multisig instead of a
  single EOA** (`npm run demo-guardian-multisig:sepolia`,
  [`scripts/demo-guardian-multisig.ts`](scripts/demo-guardian-multisig.ts))
  — proves both the pause mechanism itself (a brand-new `commitIntent()`
  correctly reverts once paused; a commitment made *before* the pause can
  still be revealed successfully *while still paused*) **and** the actual
  security upgrade that motivated replacing the EOA: one owner proposing
  a pause is not enough — a solo `execute()` attempt with only 1
  confirmation genuinely reverts on-chain, and only goes through once a
  second, independent owner also confirms. Same governance flow proven
  again for `unpause()`. Example tx:
  [propose (owner A)](https://sepolia.arbiscan.io/tx/0x3939cd2b7b2996c06d87fce545ef31cf3d553d77f966b51799694b122255ce35),
  [confirm (owner B)](https://sepolia.arbiscan.io/tx/0x2f09d55b7139b116e4bb1ef8c801f0da6eeb50e7edc28556b77a366a6fc6d34a),
  [execute pause](https://sepolia.arbiscan.io/tx/0x8fb353462938d3fdd94f31217982899e52de4c9cebeb5c0ef6c42b9aee7edfd3),
  [reveal while still paused](https://sepolia.arbiscan.io/tx/0x92bdc84b49f1b0b6fa9314340d841dcb676e93270defd2d5f4c6bbf4a375afcb),
  [unpause execute](https://sepolia.arbiscan.io/tx/0x477fe55fb4e6d131fb47edefbb3457c577085eaa617304efa5142dd56cdf3225).
  [`scripts/demo-pause.ts`](scripts/demo-pause.ts) still exists and still
  passes against any deployment where a single EOA genuinely is the
  guardian (e.g. a fresh local deploy) — it just no longer applies to
  *this* deployment now that `guardian` is a multisig.
  `AncillaSwapHook` has the identical mechanism — proven there via its own
  local test suite rather than a second live script, since it's the same
  standard logic in both places.
- **Treasury multisig** (`npm run demo-treasury:sepolia`,
  [`scripts/demo-treasury.ts`](scripts/demo-treasury.ts)) — verified live
  against the `AncillaTreasuryMultisig` deployment above (owners: the
  same two wallets used elsewhere in these demos, plus a third unfunded
  placeholder address — this is a testnet configuration, not a real
  owner set). Funded the multisig, proposed a withdrawal, confirmed
  `executeWithdrawal` **reverts with only 1 of 2 required confirmations**,
  then confirmed from a second owner and executed — the exact proposed
  amount moved, verified by balance delta, not by trusting the return
  value. This proves the multisig contract itself works correctly live;
  the current `IntentCommitReveal`'s `treasury` field is also now
  genuinely pointed at it — see the slasher-reward tx links above and
  "Mainnet readiness" below for that separate proof.
- **Bond locking** (`npm run demo-bond-lock:sepolia`, `scripts/demo-bond-lock.ts`)
  — re-verified live against **this exact deployment**. Commits an intent,
  then immediately attempts to withdraw the full bond. Confirmed on-chain
  afterward: the withdrawal reverts, and `bondBalance`/`lockedBond` are
  unchanged — proving the fix described in "Third bug" below still holds,
  on the fifth real deployment in a row, not just in `hardhat test`.
- **Direct reveal** and **relayed reveal** — verified live on an earlier
  deployment (same relay/reveal logic; none of the redeployments since
  have touched `revealIntent`/`revealIntentViaRelay` themselves), and
  re-verified against the current code via the local test suite
  (`revealIntentViaRelay` tests, plus the "emergency pause" test that
  specifically reveals *while paused* against a live-equivalent code
  path). Not yet re-run live against *this* exact deployment address —
  that's a known gap, not a hidden one. Re-running `npm run demo:sepolia`
  and `npm run demo-relay:sepolia` would close it.

## Uniswap v4 hook architecture ("Option A")

`AncillaSwapPool` proves the core narrative end-to-end, but it's a
standalone toy AMM — whatever liquidity it has is whatever got manually
seeded into it. Nobody parks real capital in a brand-new project's own
pool. This section documents a second, parallel architecture built to
close that gap: instead of Ancilla running its own AMM, a Uniswap v4 hook
gates access to a **real** v4 pool. This was a deliberate design
discussion (see the project's dossier for the original diagram-and-critique
exchange it came out of) — two options were on the table, and one was
chosen and built:

- **Option A (chosen, built)** — the hook absorbs commit-reveal entirely,
  replacing the separate reveal step with a single "reveal-and-swap"
  transaction. This is what's live today.
- **Option B (not built)** — a thinner hook that calls back into the
  existing, unmodified `IntentCommitReveal` to check a commitment was
  validly revealed, rather than reimplementing commit-reveal inside the
  hook itself. Documented here so the tradeoff is on the record, not
  because it's still an open question — Option A is what got built.

### How it actually works

There is no separate `revealIntent()` call in this architecture. Reveal
and execution are the same transaction:

1. Agent bonds and commits, same as `IntentCommitReveal`
   (`AncillaSwapHook.commitIntent`) — only the hash is on-chain.
2. Once the batch window opens, the agent calls
   `AncillaHookRouter.revealAndSwap(key, params, commitId, intentData, salt)`.
   The router calls Uniswap's real `PoolManager.unlock()`/`swap()` — v4's
   flash-accounting entrypoint — with `intentData`/`salt` attached as
   `hookData`.
3. Inside that same transaction, `AncillaSwapHook._beforeSwap` decodes
   `hookData`, verifies the hash commitment, verifies the reveal window is
   open, and — critically — verifies the swap actually being submitted
   (token, direction, exact amount) matches what was committed to, so a
   valid hash can't be reused to ride along with a different swap.
4. The real v4 swap executes against real pooled liquidity.
5. `AncillaSwapHook._afterSwap` checks the real, executed output against
   the committed `minAmountOut` and reverts the *entire* transaction if it
   falls short — so a bad swap doesn't leave the commitment consumed with
   nothing to show for it — then emits `IntentSwapExecuted`.

### Why two more small router contracts exist

Uniswap v4's `PoolManager.swap()`/`modifyLiquidity()` can only be called
from inside an `unlock()` callback (flash accounting — deltas are settled
at the end, not per-call). `AncillaHookRouter` (agent-facing swaps) and
`AncillaLiquidityRouter` (operator liquidity seeding) exist to do that
unlock/callback/settle dance. Both are deliberately **not** built on
Uniswap's own `PoolSwapTest`/`PoolModifyLiquidityTest` (official, but
`UNLICENSED` and explicitly test-only) or `v4-periphery`'s `V4Router`
(pinned to an exact `pragma solidity 0.8.26`, one version ahead of
everything else in this repo). Writing them ourselves — small, MIT,
0.8.24, fully tested — keeps every contract this repo actually deploys
self-authored and directly reasoned about, same philosophy as
`AncillaTreasuryMultisig`. `Create2Factory` exists for the same
self-authored-over-borrowed reason: v4 hook addresses must be mined so
their low bits encode the hook's permission flags (`beforeSwap`,
`afterSwap`), which needs a known, fixed CREATE2 deployer to mine a salt
against — done in TypeScript
([`scripts/lib/hookMiner.ts`](scripts/lib/hookMiner.ts), a port of
`v4-periphery`'s own `HookMiner.sol` algorithm) rather than thousands of
on-chain calls.

### Licensing, checked before writing a line of code

Uniswap v4 ships across multiple packages with different licenses, so
this was verified per-file before depending on any of it, not assumed:

| Package/file | License | Used here as |
|---|---|---|
| `@uniswap/v4-core`'s interfaces/types/libraries (`IPoolManager`, `Hooks`, `PoolKey`, `BalanceDelta`, …) | MIT | direct imports in `AncillaSwapHook`/the routers |
| `@uniswap/v4-core`'s `PoolManager.sol` itself | **BUSL-1.1** | never deployed by this repo — the real one is already live on Arbitrum, deployed and operated by Uniswap; only used *locally*, in Hardhat tests, to have something real to test against |
| `@uniswap/v4-periphery`'s `BaseHook`/`HookMiner`/`LiquidityAmounts` | MIT | direct imports (hook base contract, mining algorithm reference, liquidity math) |
| `@uniswap/v4-core`'s test utilities (`PoolSwapTest`, `PoolModifyLiquidityTest`) | **UNLICENSED** | **not used anywhere in this repo**, including local tests — see "why two more small router contracts exist" above |
| `solmate` (a transitive dependency of `PoolManager.sol`) | AGPL-3.0-only | dev-only, needed purely to *compile* `PoolManager` for local testing; never deployed by this repo to any real network |

### Verified facts this section relies on (not assumed)

- Uniswap v4 `PoolManager` is live on Arbitrum Sepolia at
  [`0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317`](https://sepolia.arbiscan.io/address/0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317)
  and on Arbitrum One (mainnet) at
  [`0x360e68faccca8ca495c1b759fd9eee466db9fb32`](https://arbiscan.io/address/0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32)
  — confirmed via
  [docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments),
  not inferred.
- `PoolManager`'s flash accounting uses EIP-1153 transient storage
  (`TSTORE`/`TLOAD`), a Cancun-hardfork opcode — Hardhat's compiler and
  local network are both explicitly configured for `evmVersion: "cancun"`
  in [`hardhat.config.ts`](hardhat.config.ts) because of this (the default,
  "paris", doesn't support it). Arbitrum itself already supports it in
  production — that's *why* the real `PoolManager` above works there at
  all.

### What this does NOT change

Same caveats as `IntentCommitReveal` apply identically here — this doesn't
hide anything from the Arbitrum sequencer, isn't a ZK system, and the
batching window is still `block.timestamp` math, not a VRF. One
additional, deliberate gap specific to this architecture: **EIP-712
relayed commit/reveal (Phase 3 in `IntentCommitReveal`) has not been
ported to `AncillaSwapHook`** — every commit and reveal-and-swap here goes
through the agent's own wallet directly. Flagged here on purpose, not
discovered later.

## Contract parameters explained

All timing is in **seconds**, measured via `block.timestamp` — see "A real
bug we hit and fixed" below for why block counts don't work on Arbitrum.

- `commitWindowSeconds` — length of one commit epoch.
- `revealDelaySeconds` — buffer after an epoch's commit window closes, before
  reveals for that epoch open. This is what gives every commit in the epoch
  the same starting line, instead of whoever committed first also revealing
  first.
- `revealWindowSeconds` — how long the shared reveal window stays open.
- `minBond` — minimum ETH balance an address must hold in-contract to be
  allowed to commit.
- `treasury` — receives slashed bonds from agents who commit and never reveal.

## A real bug we hit and fixed (kept here on purpose, not swept under the rug)

The first testnet deployment used **block-count** windows
(`commitWindowBlocks`, etc.) and `block.number` for all timing checks. It
compiled, passed all local tests, and deployed without error — but the very
first live end-to-end run against Arbitrum Sepolia failed on `reveal()` with
`RevealNotOpenYet`, even after waiting well past when the window should have
opened.

Root cause: **on Arbitrum, the `block.number` opcode read from inside a
contract returns the L1 (Ethereum) block height, not the L2 sequencer block
height** that RPC calls like `eth_blockNumber` or a transaction receipt's
`blockNumber` report. The two move at very different rates, so an off-chain
script polling L2 block numbers and a contract counting in L1 blocks
disagree about how much "time" has passed. Local Hardhat-network tests never
caught this because there's only one block-number concept in a local
sandbox — the bug only exists against a real Arbitrum node.

Fix: the contract was rewritten to use `block.timestamp` (seconds)
everywhere instead of `block.number`. `block.timestamp` does not have this
L1/L2 split — it's consistent between what the contract sees and what any
RPC client sees. This is also what Arbitrum's own docs recommend for
time-sensitive on-chain logic. See the header comment in
[`IntentCommitReveal.sol`](contracts/IntentCommitReveal.sol) for the full
explanation, and `scripts/demo.ts` for the live re-verification against the
redeployed contract.

**Lesson for anyone building on Arbitrum:** if your contract's timing logic
only exists as unit tests on a local Hardhat network, it has not actually
been proven correct on Arbitrum — the L1/L2 block-number split is invisible
in that sandbox. Verify against a real testnet before trusting the logic.

### Second bug: a hand-typed constant was wrong by one hex digit

While building the relay signature verification
(`revealIntentViaRelay`/`_recoverSigner`), the contract rejected every
signature — including ones produced correctly by the agent's own wallet —
with `InvalidSignatureS`, as if every signature were malleable/non-canonical.

Root cause: the `SECP256K1_HALF_N` constant used to detect "high-s"
signatures had been hand-typed and was missing one trailing hex digit (63
characters instead of the correct 64), making the threshold smaller than the
true curve half-order. That made the check reject a large fraction of
perfectly valid signatures. This was caught by computing the constant fresh
in a standalone script and comparing it character-by-character against the
one in the contract — they didn't match.

Fix: the contract no longer hand-types the half-order at all. It hard-codes
only the well-known curve order `SECP256K1_N` and derives
`SECP256K1_HALF_N = SECP256K1_N / 2` as a compiler-evaluated constant
expression, so there's only one number to get right, not two copies that can
drift apart.

**Lesson:** don't hand-derive and hand-type a value twice when the compiler
can derive the second one from the first — and don't trust a "this looks
like the right constant" gut check for cryptographic parameters. Compute it,
don't recall it.

### Third bug: bond could be withdrawn right after committing, before ever being slashed

This one isn't a coding mistake in the usual sense — the code did exactly
what it was written to do. It's a gap in the *economic design* that only
surfaced from deliberately auditing test coverage after being asked "are
you sure none of this has bugs?" instead of just asserting confidence.

`withdrawBond()` had no awareness of an agent's pending, unresolved
commitments. Nothing locked bond to a specific commitment the way a per-tx
escrow would. So the entire point of requiring a bond — making
commit-and-vanish costly — could be fully sidestepped: commit, withdraw the
whole bond in the very next transaction, then never reveal. `slashNoReveal()`
could still be called on the abandoned commitment, but by then
`bondBalance` was already 0, so it slashed nothing. A test written to
*prove* this (not just assert it away) passed against the old code,
confirming the gap was real, not theoretical.

Fix: added `lockedBond[agent]`, incremented by `minBond` on every
`commitIntent()` and decremented on whichever resolution happens first
(`revealIntent`/`revealIntentViaRelay`, or `slashNoReveal`).
`withdrawBond()` now rejects any withdrawal that would drop the remaining
balance below the agent's currently locked amount. An agent with multiple
concurrent pending commitments now needs bond covering all of them at once
— `minBond * pendingCount` — not just one.

**Lesson:** a function can be 100% bug-free in isolation and still break
the property the *system* was supposed to guarantee, if two functions'
invariants were never made to depend on each other. Test coverage numbers
(this repo went from 75.9% to 93.1% branch coverage while chasing this)
don't just catch missed `if` branches — chasing them down is what surfaced
this gap in the first place, because the missing branch was "what happens
to `bal` in `slashNoReveal` when it's smaller than expected," and asking
that question is what led to asking "how could `bal` end up smaller than
expected" at all.

### Fourth+: three more bugs, found building the relay-server prototype

Documented in full in [`relay-server/README.md`](relay-server/README.md)
rather than duplicated here — short version: an `ethers.Contract` built
with a function-only ABI (no error definitions) meant every revert reason
was invisible, which broke a retry-vs-fail decision that depended on
telling `RevealNotOpenYet` apart from a real failure; then, even after
adding the error definitions, the specific ethers properties expected to
carry the decoded error name turned out not to be populated on this ethers
version's thrown exceptions at all (found by manually matching the raw
4-byte selector against each error's keccak256 hash by hand, then fixed by
using `Interface.parseError()`, the actually-documented API for this); and
separately, an E2E test script's own bond top-up logic didn't account for
bond already locked by a prior unresolved commitment. None of these were
contract bugs — the contract behaved correctly the whole time — they were
all in the off-chain tooling built around it, which is its own lesson: the
contract being correct doesn't mean everything calling it is.

### Fifth: two genuinely flaky tests, found by setting up CI

Setting up [`.github/workflows/ci.yml`](.github/workflows/ci.yml) meant
actually running what CI runs — `npm ci` plus a compile from a fully clean
state — rather than assuming the workflow file was correct because the
YAML parsed. That surfaced two tests
("rejects a commit/relay submission after its own deadline has passed")
that reliably passed in isolation but reproducibly **failed** in a full
suite run, and had almost certainly been the unexplained cause of an
earlier "1 test failed under coverage" run that hadn't reproduced when
investigated at the time (see "Third bug" section) — coverage's slower,
instrumented execution made the same underlying race more likely to
surface, without it being coverage-specific.

Root cause: both tests built a signature with `signCommitRequest`/
`signRevealRequest` using a 10-second deadline computed from real
wall-clock `Date.now()`, then called `time.increase(11)` — advancing the
*simulated chain's* clock by 11 seconds from wherever `loadFixture`'s
cached snapshot left it. That's two different clocks with only a
1-second margin between them. Early in a test run, or in isolation, that
margin holds. Deep into a ~48-test run, enough real wall-clock time has
elapsed executing the other tests that `Date.now()` can already be more
than 1 second ahead of the fixture's chain-time snapshot, silently eating
the margin — the deadline hadn't actually passed yet from the chain's own
perspective, so the transaction didn't revert and the test failed on `to
.be.revertedWithCustomError`.

Fix: both tests now sign manually with a deadline computed from chain time
(`time.latest()`) instead of going through the SDK's wall-clock-based
helper, then advance chain time by a full 100 seconds past it — comfortable
margin, entirely in one clock's terms. Verified with 5 consecutive
`npm test` runs and 3 consecutive `npm run coverage` runs, all clean, after
a fully clean recompile each time.

**Lesson:** "passes when I run it" and "passes reliably in CI" are
different claims, and the gap between them is often exactly this shape —
a resource (real time, in this case) that behaves consistently in a short,
isolated run and inconsistently once enough of something else has
happened first. This is also the second time this exact class of bug
(mixing real `Date.now()` with simulated chain time) has shown up in this
codebase — the `DEADLINE_BUFFER` constant elsewhere in the test suite was
the fix for the first occurrence. Two independent instances of the same
mistake is worth naming as a pattern, not just fixing case by case: **any
test in this suite that needs an "already expired" deadline must derive
it from `time.latest()`, never from `Date.now()`.**

### Sixth: a wrong assumption about the AMM's own math, caught before it became a bad test

While chasing branch coverage on `AncillaSwapPool.swap()`'s
`if (amountOut >= reserveOut) revert InsufficientLiquidity()` guard, the
first instinct was: pick an absurdly large `amountIn`, since intuitively
that should push `amountOut` past the entire opposite reserve. A test was
about to be written asserting exactly that.

Checked the arithmetic first instead, in a throwaway Node script with
`BigInt` — the same constant-product-with-fee formula
(`amountOut = amountIn·997·reserveOut / (reserveIn·1000 + amountIn·997)`)
used in the contract, tried with `amountIn` up to 10^40 tokens. Result:
`amountOut` asymptotically approaches `reserveOut` but, under Solidity's
floor (integer) division, never reaches it — not at any finite input. The
guard is real code but mathematically unreachable given the formula
upstream of it.

No contract bug here — the formula and the guard are both correct as
written. The near-miss was almost writing a test with a false premise
("large `amountIn` triggers this") that would have either failed
confusingly or, worse, been "fixed" by loosening the contract's actual
logic to make a wrong test pass. Fixed by testing what's actually
reachable (`getAmountOut`'s own zero-reserve check, hit by swapping
against a pool with no liquidity yet) and documenting the unreachable guard
as intentional defense-in-depth directly in the contract, the same pattern
already used for `slashNoReveal`'s post-bond-locking fallback.

**Lesson:** "trace the code path to see what triggers a branch" and "the
branch is provably reachable" are different levels of confidence — the
first is how most of this repo's other coverage gaps got closed correctly,
but for anything involving a mathematical formula, tracing the code isn't
enough; run the actual numbers before writing the assertion.

### Seventh: two live-demo scripts asserted an absolute balance instead of a delta

While proving the emergency-pause redeployment live, `npm run demo-swap:sepolia`
failed a run that should have passed — the swap itself worked correctly
on-chain, but the script's own verification step reported `❌ DEMO FAILED`.

Root cause: both `demo-swap.ts` and (found first, a few sessions earlier)
`demo-hook-swap.ts` asserted the agent's post-swap token balance against an
*absolute* expected value (`agent aUSD balance after: 0` /
`agent aETH balance after: <exact quoted amount>`), on a wallet that is
deliberately **reused** across every demo script in this repo. By the time
either script ran again, the wallet already held leftover tokens from an
earlier demo run, so the absolute assertion was comparing against the
wrong baseline — the swap itself was correct throughout; only the
verification logic's assumption was wrong.

Fix: both scripts now snapshot the agent's balance *before* the swap and
assert the **delta** — "exactly `amountIn` left, exactly the quoted
output arrived" — instead of an absolute post-swap value. This is a
different, narrower claim than "the wallet balance is X," and it's the
one that's actually being tested.

**Lesson:** the same mistake shape appeared independently in two sibling
scripts, months apart in this project's timeline — a reused test/demo
wallet across multiple runs means "assert an absolute balance" is very
nearly always the wrong check; "assert a balance delta" is the one that
survives being run more than once.

## Project quality tooling

Beyond the test suite, this repo wires up a few objective, tool-generated
checks rather than relying on manual review alone:

| Command | What it shows |
|---|---|
| `npm test` | 148 tests, run 3x consecutively during development to rule out flakiness |
| `npm run coverage` | Istanbul/solidity-coverage report — 100% statements/lines/functions across every contract, 94-100% branches on each core contract (`IntentCommitReveal` 94.74%, `AncillaSwapPool` 94.12%, `AncillaTreasuryMultisig` 95.45%, `SwapExecutor` 100%, `AncillaSwapHook` 72%). The `ecrecover`-returns-zero-address branch, once (wrongly) written off here as "impractical to force deliberately," turned out not to be — a signature with `r=0` (not a valid secp256k1 x-coordinate) reliably makes `ecrecover` return the zero address, and is now an actual test. What's left uncovered is genuinely dead by design: defensive fallback code in `slashNoReveal` that the bond-locking fix made intentionally unreachable, `AncillaSwapPool.swap()`'s own equivalent guard, which the AMM formula's own math makes unreachable (see "Sixth" bug), and — honestly, not yet chased down — some delta-sign edge branches in `AncillaHookRouter`/`AncillaLiquidityRouter` (e.g. a swap that moves zero of one currency) that every test so far happens not to hit. |
| `npm run gas-report` | Per-function gas cost table (e.g. `commitIntent` ~78–95k gas, `revealIntentViaRelay` ~52k gas) |
| `npm run size` | Deployed bytecode size — `IntentCommitReveal` is 7.10 KiB, `AncillaSwapHook` 6.24 KiB, `AncillaSwapPool` 2.14 KiB, `AncillaTreasuryMultisig` 2.26 KiB, `AncillaHookRouter` 2.77 KiB, `AncillaLiquidityRouter` 2.28 KiB, `SwapExecutor` 1.23 KiB — all well under the 24 KiB EIP-170 limit Arbitrum also enforces (Uniswap's own `PoolManager`, at ~19.3 KiB, is the one contract in this stack close to that ceiling — and it isn't ours; it's already deployed and live) |

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push
and pull request against `main`/`master`: compiles and runs the full test
suite on Node 18.x and 20.x, then (in a separate job) runs coverage and the
contract-size check, uploading the coverage report as a build artifact.

What it deliberately does **not** run: `scripts/demo*.ts` and
`scripts/relay-server*-e2e.ts`. Those need either a live Arbitrum Sepolia
RPC plus funded testnet wallets, or a long-running local node with spawned
relay-server processes — not something a CI pass/fail signal should depend
on. They stay manual, run locally when actually verifying a live/e2e
change.

Before this existed, tests only ran when someone remembered to run them by
hand. Setting it up caught one more real bug in the process (see "Bugs we
hit and fixed"), found by running the exact sequence CI runs — `npm ci`
(strict, fails if `package-lock.json` and `package.json` disagree, unlike
`npm install`), then a compile from a genuinely clean state (`artifacts/`,
`cache/`, `typechain-types/` all deleted first — a local `npm test` run
otherwise reuses whatever was already compiled, which isn't what a fresh
CI checkout gets).

## License

MIT
