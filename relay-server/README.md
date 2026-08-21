# Ancilla relay server (prototype)

A real, runnable HTTP server implementing the relay side of
`commitIntentViaRelay` / `revealIntentViaRelay`. Agents POST signed
authorizations here instead of ever submitting a transaction to
`IntentCommitReveal` themselves.

**What this is:** a working prototype proving the relay mechanism end-to-end
through an actual server process — not just a one-shot demo script. Verified
two ways:
- Manually, end-to-end, via `scripts/relay-server-e2e.ts` /
  `relay-server-multi-e2e.ts`, which spawn a real server process and talk to
  it purely over HTTP.
- Automatically, in `npm test` (`test/relay-server.test.ts`, 10 tests) —
  the Express app and background worker are factored into `app.ts` as a
  plain `createRelayApp(config)` factory specifically so they can be tested
  in-process with `supertest`, against Hardhat's in-process network, without
  spawning a process or binding a real port. `index.ts` is now just the CLI
  entry point (env vars → `createRelayApp` → listen). Before this split, the
  relay-server package had zero automated test coverage — everything was
  manual E2E runs.

**What this is NOT:** a hosted, production, always-on service. Running it
means starting a local Node process that lives as long as your terminal
does. There is no deployment to a VPS/cloud host, no TLS, no
authentication or rate-limiting, and no coordination between multiple
instances beyond both racing on the same permissionless contract functions
(see "Redundancy" below — this covers one failure mode, not full
decentralization: there's still no relay operator discovery, reputation,
or staking). Turning this into a real, trustworthy public service is
genuine infrastructure work outside what this repo delivers — see the main
[README](../README.md)'s roadmap section.

## Redundancy: surviving a relay going down

Two things make this less of a single point of failure than the first
version of this prototype was:

1. **Persistence.** The pending-reveal queue is written to a local JSON
   file (`relay-server/.queue-<port>.json`) after every state change and
   reloaded on startup — a process restart doesn't drop work that was
   already accepted.
2. **Multi-relay submission.** `commitIntentViaRelay` and
   `revealIntentViaRelay` are both permissionless — any holder of a validly
   signed request can submit it, not just one designated relay address.
   So an agent can hand the same signed request to *multiple independent*
   relay-server instances. Whichever gets there first wins; the others
   just see `AlreadyRevealed`/`AlreadyCommitted` and no-op harmlessly (the
   relay server recognizes this specific case and marks its own job
   `confirmed` rather than `failed` — see `processPendingReveals()`).

Proven live with `npm run relay-server:multi-e2e`
(`scripts/relay-server-multi-e2e.ts`): starts two relay-server instances on
different ports with different relay wallets, POSTs the same signed reveal
to both, **kills one of them before the reveal window even opens**, and
confirms the survivor still gets the reveal on-chain by itself.

What this does *not* solve: there's still no shared discovery mechanism —
an agent has to already know about (and trust) multiple relay endpoints to
submit to. A relay registry, staking/reputation for relay operators, and
actual hosting redundancy (not just "the code tolerates it") are still
unbuilt.

## Running it locally

Three processes, three terminals (or run each with `run_in_background` if
you're doing this from a script/agent):

```bash
# 1. A local chain
npx hardhat node

# 2. Deploy IntentCommitReveal + a MockExecutor to it, writes
#    relay-server/local-deployment.json with the addresses
npm run deploy:local

# 3. Start the relay server (uses one of Hardhat's default funded test
#    accounts as the relay wallet — see hardhat node's own startup log for
#    the exact address/key list; do NOT reuse these on any real network)
RELAY_RPC_URL=http://127.0.0.1:8545 \
RELAY_CONTRACT_ADDRESS=<contractAddress from local-deployment.json> \
RELAY_PRIVATE_KEY=<any funded local test account's private key> \
npm run relay-server
```

Then, in a fourth terminal:

```bash
npm run relay-server:e2e
```

This signs a commit and a reveal as a *different* local test account (the
"agent"), POSTs both to the relay server over HTTP, and independently
re-reads on-chain state afterward to confirm the relay server actually
submitted both transactions correctly and attributed them to the agent, not
itself.

To see redundancy in action instead (no manual relay-server startup needed
— this script starts and stops both instances itself):

```bash
npm run relay-server:multi-e2e
```

## API

| Endpoint | Method | Body | Behavior |
|---|---|---|---|
| `/health` | GET | — | Returns the relay's own address, target contract, and RPC URL |
| `/commit` | POST | `{commitId, commitHash, agent, deadline, signature}` | Submits immediately, returns the tx hash or an error |
| `/reveal` | POST | `{commitId, intentData, salt, executor, agent, deadline, signature}` | Accepted (202) and queued; a background worker polls every 5s and submits once the reveal window opens |
| `/status/:commitId` | GET | — | `pending` / `submitted` / `confirmed` / `failed` / `expired` |

## Real bugs found building this (not hidden)

1. **Missing error definitions in the ABI.** The `ethers.Contract` instance
   was constructed with only function signatures, no `error ...` entries.
   Every revert surfaced as `"unknown custom error"`, which meant the
   worker's check for "is this just RevealNotOpenYet, keep waiting" could
   never match — every reveal attempted even one second before its window
   opened was wrongly marked permanently `failed` instead of retried.
2. **`err.revert.name` / `err.errorName` don't exist on this ethers
   version's thrown errors**, even after fixing the ABI. Found by logging
   the raw error and manually matching the 4-byte selector in `err.data`
   against each error signature's keccak256 hash by hand — it really was
   `RevealNotOpenYet`, just not exposed where expected. Fixed by using
   `Interface.parseError(err.data)`, the actual documented way to decode
   this.
3. **The E2E test script's own bond top-up logic** only checked
   `bondBalance < minBond`, not accounting for bond already locked against
   an unresolved commitment from a previous run — reproducibly hit
   `BondTooLow` on a second run before this was fixed.
4. **The multi-relay E2E script's ABI was missing `commitIntentViaRelay`
   entirely** (copy-paste from an earlier, reveal-only ABI list) — failed
   immediately with `TypeError: contract.commitIntentViaRelay is not a
   function` the first time it ran, before ever touching the relay
   redundancy logic it was written to test.
5. **The same script leaked both spawned relay-server child processes on
   any error** — nothing killed them if the script threw between spawning
   and its own explicit cleanup at the end, so the failed run above left
   two orphaned Node processes holding ports 8788/8789, blocking the next
   attempt until manually killed. Fixed with `try { ... } finally { kill
   both }` wrapping the whole scenario.
6. **Not a bug, but a real design nuance an automated test surfaced that
   manual E2E runs never would have:** `processPendingReveals()` has two
   independent, both-safe ways a job past its deadline can end — a local
   `Date.now()` pre-check (gas-saving, marks the job `expired`) and the
   contract's own authoritative `block.timestamp > deadline` check (marks
   the job `failed` with `SignatureExpired` if the local pre-check didn't
   catch it first, e.g. clock skew). A test originally asserted only the
   `expired` path and failed under Hardhat's simulated-time test
   environment, where fast-forwarding the chain's clock doesn't advance
   real wall-clock time the local pre-check reads — revealing the
   distinction rather than a defect. Fixed by testing the actual
   invariant (never stuck `pending`, never wrongly `confirmed`) instead of
   one specific status label, and documented in both `app.ts` and here.
