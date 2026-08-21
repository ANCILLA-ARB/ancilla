# Deploying the relay server

This covers turning the relay-server prototype into an actual running,
publicly-reachable process — the piece the main README's "Mainnet
readiness" table lists as blocked on a hosting decision, not on more code.
Everything in this file is deployment **configuration**: no account was
created, no service was provisioned, and nothing here holds any secret.
That part is yours to do, on whichever provider you choose.

## What's actually been verified before you deploy anything

- `npm run build:relay-server` compiles `relay-server/*.ts` (only —
  [`relay-server/tsconfig.json`](tsconfig.json) is scoped so this never
  touches contracts, tests, or Hardhat) into plain JS in `dist/relay-server/`.
- The compiled output, run directly with `node dist/relay-server/index.js`,
  was proven live against a local Hardhat node: full commit → relay-server
  `/commit` → relay-server `/reveal` → background poll worker confirms
  on-chain, exactly the same `relay-server-e2e.ts` flow this repo already
  used to verify the `ts-node`-run version — just run once more against the
  **compiled** binary specifically, since that's what actually ships in the
  Docker image below.
- Along the way, a real bug: `ethers` and `dotenv` were both missing from
  `package.json`'s `dependencies` (only reachable as transitive/dev
  dependencies) — a production-only install (`npm ci --omit=dev`, which is
  exactly what the Docker image's runtime stage does) would have failed
  with `Cannot find module 'ethers'`. Fixed by moving both to
  `dependencies` where they actually belong, given the relay-server needs
  them at runtime.
- **What was NOT verified:** the actual `docker build` — Docker isn't
  available in the sandbox this was built in. The Dockerfile's individual
  steps (`npm ci`, the `tsc` build, running the compiled entrypoint) were
  each verified directly and independently, but the Docker layer-copy
  mechanics themselves are untested. **Run `docker build` yourself and
  confirm the image starts before deploying it anywhere** — see below.

## 1. Build and smoke-test the image locally

```bash
# from the repository root — the Dockerfile needs the root as build
# context (it reads package.json before it ever reaches relay-server/)
docker build -f relay-server/Dockerfile -t ancilla-relay-server .

docker run --rm -p 8787:8787 \
  -e RELAY_RPC_URL="https://sepolia-rollup.arbitrum.io/rpc" \
  -e RELAY_CONTRACT_ADDRESS="<IntentCommitReveal address from deployments/arbitrumSepolia.json>" \
  -e RELAY_PRIVATE_KEY="<a TESTNET-ONLY key — never a real one, see below>" \
  ancilla-relay-server

# in another terminal
curl http://127.0.0.1:8787/health
```

If `/health` responds, the image works. Confirm this before touching any
real hosting provider.

## 2. Required environment variables

| Variable | Required | What it is |
|---|---|---|
| `RELAY_CONTRACT_ADDRESS` | yes | The `IntentCommitReveal` (or `AncillaSwapHook`) address this relay submits to. |
| `RELAY_PRIVATE_KEY` | yes | The relay wallet's private key — it pays gas for every commit/reveal it submits. **Testnet-only for now; treat a mainnet relay key with the same care as any hot wallet holding real funds, and never put it in a Dockerfile, a repo file, or a platform's build logs.** |
| `RELAY_RPC_URL` | yes (defaults to `127.0.0.1:8545`, wrong for anywhere but local) | An Arbitrum RPC endpoint — the public one works, a dedicated provider (Alchemy/Infura/QuickNode) is more reliable for a long-running service. |
| `RELAY_PORT` | no (defaults to `8787`) | Match whatever port your platform expects the app to listen on. |
| `RELAY_STORE_PATH` | no (defaults to `relay-server/.queue-<port>.json`) | Where the pending-reveal queue persists — see the next section before deploying for real. |

Set these through your platform's own secrets manager (`fly secrets set
NAME=value`, Railway's environment variables UI, etc.) — never commit
real values to this repo or bake them into the Docker image.

## 3. The persistence caveat, read before deploying for real

The pending-reveal queue is a local JSON file. Most container-hosting free
tiers give you an **ephemeral** filesystem — it can reset on every
redeploy or restart, silently dropping any reveal the relay had accepted
but not yet confirmed at that exact moment. Two ways to handle this,
neither implemented here since which one's right depends on the platform
you actually pick:

- **Mount a persistent volume** (Fly.io: `fly volumes create`, see the
  commented-out block in [`fly.toml`](../fly.toml); Railway has an
  equivalent "Volumes" feature) and point `RELAY_STORE_PATH` at a file
  inside it.
- **Accept the risk.** The relay is explicitly an optional convenience —
  every commit/reveal it submits, an agent could always submit directly
  instead (see the main README's "What this does NOT do"). A dropped
  in-flight reveal isn't a fund-safety issue, it's a "that specific
  request needs to be retried" issue. For a first deployment, this may be
  good enough.

## 4. Fly.io

[`fly.toml`](../fly.toml) is set up for this specifically. First edit its
`app` name to something you actually own, then:

```bash
fly launch --copy-config --no-deploy   # claims the app name against fly.toml, first time only
fly secrets set RELAY_CONTRACT_ADDRESS=0x... RELAY_PRIVATE_KEY=0x... RELAY_RPC_URL=https://...
fly deploy
```

## 5. Railway

[`railway.json`](../railway.json) tells Railway to build
`relay-server/Dockerfile` instead of auto-detecting a build. Connect the
GitHub repo through Railway's dashboard, set the same environment
variables there (Settings → Variables), and it deploys on push.

## 6. Whichever platform you use

- Check each provider's own current pricing/free-tier terms yourself
  before deploying — this file deliberately doesn't quote numbers that can
  go stale.
- Point `RELAY_RPC_URL` at a dedicated RPC provider, not the public
  endpoint, once this is meant to run continuously — the public one has no
  uptime guarantee for a long-running poll worker.
- This deploys **one** relay instance. The whole point of the
  `relay-server-multi-e2e.ts` proof in the main README is that agents can
  submit the same signed request to several independent instances — true
  redundancy means repeating this on a second provider/account, not
  something a single deployment gives you by itself.
