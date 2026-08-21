# Ancilla

[![CI](https://github.com/ANCILLA-ARB/ancilla/actions/workflows/ci.yml/badge.svg)](https://github.com/ANCILLA-ARB/ancilla/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636?logo=solidity&logoColor=white)](contracts/IntentCommitReveal.sol)
[![Network](https://img.shields.io/badge/Arbitrum-Sepolia_testnet-28A0F0?logo=arbitrum&logoColor=white)](https://sepolia.arbiscan.io/address/0xb2a513260DA2e61490386B3BE1773DB99d5a91f3)

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
- [Contract parameters explained](#contract-parameters-explained)
- [Bugs we hit and fixed](#a-real-bug-we-hit-and-fixed-kept-here-on-purpose-not-swept-under-the-rug) — 6 real ones, kept on the record, not cleaned up out of the story
- [Project quality tooling](#project-quality-tooling) — coverage, gas, CI
- [License](#license)

## What actually exists right now (verified, not claimed)

- [`contracts/IntentCommitReveal.sol`](contracts/IntentCommitReveal.sol) —
  the core contract. Agents commit a hash of their intent, then reveal it
  only inside a shared batch window so many agents' intents surface together
  instead of one at a time.
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
  to disk so a restart doesn't drop pending work. **Not** a hosted 24/7
  service — see [`relay-server/README.md`](relay-server/README.md) for
  exactly what it is and isn't, and 5 more real bugs found building it.
  Proven end-to-end via `npm run relay-server:e2e` (single relay, over
  HTTP) and `npm run relay-server:multi-e2e` (two independent relay
  instances given the same signed reveal — kills one mid-flight and
  confirms the other completes it anyway, since both relay functions are
  permissionless by design).
- [`test/IntentCommitReveal.test.ts`](test/IntentCommitReveal.test.ts) — **38
  tests**, [`test/relay-server.test.ts`](test/relay-server.test.ts) — **10
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
  a malicious withdrawal recipient that is also a listed owner. **93 tests
  total, all passing** (re-run 3x
  consecutively to rule out flakiness). 100% statement/line/function
  coverage, 94%+ branch coverage on every core contract (`npm run coverage`
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
npm test              # 93 tests (38 + 10 relay-server + 20 swap executor + 25 treasury multisig)
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
  Everything in this repo is self-reviewed in the meantime: 93 unit tests,
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
| Treasury as a multisig, not a single EOA | ✅ [`AncillaTreasuryMultisig`](contracts/AncillaTreasuryMultisig.sol) built, 25 tests (including a deliberate reentrancy attack), **proven live on Sepolia** (`npm run demo-treasury:sepolia`) — a withdrawal correctly rejected with 1/2 confirmations, then executed for the exact amount with 2/2. **Not yet wired into a live `IntentCommitReveal`** — needs a fresh `IntentCommitReveal` deployment with `treasury` pointed at it, since the field is immutable. |
| Emergency pause / circuit breaker | ⚪️ not started. `IntentCommitReveal` currently has no way to halt new commits if a critical bug is found post-deploy — the only recourse today would be deploying a replacement contract, which does nothing for funds already inside the old one. Next item planned. |
| Economic model hardening (bond/slashing) | ⚪️ not started. Still a flat `minBond` per commitment — not stake-weighted, no reputation system. Needs deliberate adversarial stress-testing (not just more unit tests) before it's trusted with mainnet-scale value. |
| Batching randomness | ⚪️ not started, low priority. `block.timestamp`-based epochs are fine for an MVP; not adversarially hardened against a sequencer biasing timestamps within Ethereum's allowed drift. |
| Relay-server hosting | ⚪️ not started, non-blocking. The protocol doesn't depend on it — an agent can always call `commitIntent`/`revealIntent` directly — so this affects convenience/privacy-layer availability, not fund safety. |
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
| `IntentCommitReveal` (relay support + bond locking) | [`0xb2a513260DA2e61490386B3BE1773DB99d5a91f3`](https://sepolia.arbiscan.io/address/0xb2a513260DA2e61490386B3BE1773DB99d5a91f3) |
| `TestTokenA` (aUSD, mintable test ERC20) | [`0xCf7fC3b5A96cc8ef46D558fB455B63ec862ba977`](https://sepolia.arbiscan.io/address/0xCf7fC3b5A96cc8ef46D558fB455B63ec862ba977) |
| `TestTokenB` (aETH, mintable test ERC20) | [`0x9487f45a0fEf6C96d1571Ae7B32f020995710f73`](https://sepolia.arbiscan.io/address/0x9487f45a0fEf6C96d1571Ae7B32f020995710f73) |
| `AncillaSwapPool` (constant-product AMM, aUSD/aETH) | [`0x3663a10bB68cEbe477843673385d5D97ea12cb0b`](https://sepolia.arbiscan.io/address/0x3663a10bB68cEbe477843673385d5D97ea12cb0b) |
| `SwapExecutor` (real `IIntentExecutor`) | [`0x10896dDf2e5D5E9fbc2Eb3dd2C65719A86aaDc76`](https://sepolia.arbiscan.io/address/0x10896dDf2e5D5E9fbc2Eb3dd2C65719A86aaDc76) |
| `AncillaTreasuryMultisig` (2-of-3, see "Mainnet readiness") | [`0xC5d4f69B53520DC5a625BA8197176E053C845800`](https://sepolia.arbiscan.io/address/0xC5d4f69B53520DC5a625BA8197176E053C845800) |

Deployed with `commitWindowSeconds=120`, `revealDelaySeconds=30`,
`revealWindowSeconds=120`, `minBond=0.001 ETH`. Source is not yet verified on
Arbiscan (no API key configured) — the contract works regardless, just
without human-readable source in the explorer UI. Verify it yourself with
`npx hardhat verify --network arbitrumSepolia <address> 120 30 120 1000000000000000 <treasury>`
once you set `ARBISCAN_API_KEY` in `.env`.

This is the third deployment of this contract — the first two used earlier
code that had since-fixed bugs (see "Bugs we hit and fixed"). Being precise
about what's actually been proven where, instead of implying everything was
re-run against every deployment (testnet ETH for the demo wallets ran low
partway through this session, and topping up requires a manual faucet claim
— not something worth overstating just to avoid saying that):

- **Real swap execution** (`npm run demo-swap:sepolia`,
  [`scripts/demo-swap.ts`](scripts/demo-swap.ts)) — verified live against
  **this exact deployment**, all four swap-stack contracts above. Seeds
  pool liquidity, mints the agent 1000 aUSD, quotes the expected output via
  `pool.getAmountOut()` *before* committing, commits the swap intent
  (on-chain, only the hash visible), waits out the real batch reveal
  window, then reveals — which is the moment `SwapExecutor` pulls the
  aUSD, calls `pool.swap()`, and sends aETH back to the agent. Verified
  independently afterward, not just trusted from script output: agent's
  on-chain aETH balance (`0.493579017198530649`) matched the pre-commit
  quote *exactly*, aUSD balance was 0, and both the pool's `Swap` event and
  `SwapExecutor`'s `IntentSwapExecuted` event were each found once. Example
  tx sequence: [seed liquidity](https://sepolia.arbiscan.io/tx/0x1dc5c704d2ea5b3d8509011559be754500ed4dc52fee93a139b355af4b31bb07),
  [deposit bond](https://sepolia.arbiscan.io/tx/0x54791f6a1317bcba838ce3cb07465ef33d40af1a7119c7e23149f8a9a3f45506),
  [commit intent](https://sepolia.arbiscan.io/tx/0xcbf01b7312e308f44a235442ead261014e46a8eb65cea4489dea4d7a1146d5be),
  [reveal + real swap](https://sepolia.arbiscan.io/tx/0x58c076f8f5b52791b33311cc689efc7b266da529a131551e6733118110c53111).
  This closes what was, until now, the single biggest gap between "tested
  locally" and "the project's actual core narrative, proven live."
- **Treasury multisig** (`npm run demo-treasury:sepolia`,
  [`scripts/demo-treasury.ts`](scripts/demo-treasury.ts)) — verified live
  against the `AncillaTreasuryMultisig` deployment above (owners: the
  same two wallets used elsewhere in these demos, plus a third unfunded
  placeholder address — this is a testnet configuration, not a real
  owner set). Funded the multisig, proposed a withdrawal, confirmed
  `executeWithdrawal` **reverts with only 1 of 2 required confirmations**,
  then confirmed from a second owner and executed — the exact proposed
  amount moved, verified by balance delta, not by trusting the return
  value. Note the scope: this proves the multisig contract itself works
  correctly live; it does **not** mean the currently-live
  `IntentCommitReveal` is using it yet (see "Mainnet readiness").
- **Bond locking** (`npm run demo-bond-lock:sepolia`, `scripts/demo-bond-lock.ts`)
  — verified live against **this exact deployment**
  (`0xb2a51326...5a91f3`). Commits an intent, then immediately attempts to
  withdraw the full bond. Confirmed on-chain afterward: the withdrawal
  reverts, and `bondBalance`/`lockedBond` are unchanged — proving the fix
  described in "Third bug" below holds on real Arbitrum, not just in
  `hardhat test`.
- **Direct reveal** and **relayed reveal** — verified live on the
  *previous* deployment (`0x23698aE0...d829994`, same relay/reveal logic;
  the bond-locking fix only touched `commitIntent`/`withdrawBond`/`slashNoReveal`
  plus one added line in the shared reveal path), and re-verified against
  the current code via the local test suite (`revealIntentViaRelay` tests,
  plus "releases the lock ... once the commitment is actually revealed"
  specifically exercises the changed line). Not yet re-run live against
  *this* exact deployment address — that's a known gap, not a hidden one.
  Re-running `npm run demo:sepolia` and `npm run demo-relay:sepolia` against
  `0xb2a51326...5a91f3` once the demo wallets are topped up would close it.

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

## Project quality tooling

Beyond the test suite, this repo wires up a few objective, tool-generated
checks rather than relying on manual review alone:

| Command | What it shows |
|---|---|
| `npm test` | 93 tests, run 3x consecutively during development to rule out flakiness |
| `npm run coverage` | Istanbul/solidity-coverage report — 100% statements/lines/functions across every contract, 94-100% branches on each core contract (`IntentCommitReveal` 95.16%, `AncillaSwapPool` 94.12%, `AncillaTreasuryMultisig` 95.45%, `SwapExecutor` 100%). The `ecrecover`-returns-zero-address branch, once (wrongly) written off here as "impractical to force deliberately," turned out not to be — a signature with `r=0` (not a valid secp256k1 x-coordinate) reliably makes `ecrecover` return the zero address, and is now an actual test. What's left uncovered is genuinely dead by design: defensive fallback code in `slashNoReveal` that the bond-locking fix made intentionally unreachable, and `AncillaSwapPool.swap()`'s own equivalent guard, which the AMM formula's own math makes unreachable (see "Sixth" bug). |
| `npm run gas-report` | Per-function gas cost table (e.g. `commitIntent` ~78–95k gas, `revealIntentViaRelay` ~52k gas) |
| `npm run size` | Deployed bytecode size — `IntentCommitReveal` is 6.31 KiB, `AncillaSwapPool` 2.19 KiB, `AncillaTreasuryMultisig` 2.95 KiB, `SwapExecutor` 1.26 KiB — all well under the 24 KiB EIP-170 limit Arbitrum also enforces |

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
