# Builds and runs ONLY the relay-server — not the contracts, not Hardhat,
# not the test suite. Multi-stage on purpose: the builder stage needs the
# full npm install (TypeScript, etc.) to compile; the runtime stage only
# ever gets the compiled JS plus production dependencies, so the deployed
# image doesn't carry Hardhat, the Solidity compiler, or any dev tooling.
#
# Build context MUST be the repository root (not relay-server/), because
# the build needs package.json/package-lock.json and relay-server/tsconfig.json
# extends nothing outside relay-server/ but tsc still needs node_modules
# installed at the root. Example:
#   docker build -f relay-server/Dockerfile -t ancilla-relay-server .
#
# See relay-server/DEPLOYMENT.md for what env vars this needs at runtime,
# and — importantly — the pending-reveal queue's persistence caveat on a
# platform with an ephemeral filesystem.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY relay-server ./relay-server
RUN npm run build:relay-server

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/relay-server ./dist/relay-server

# Not baked in — set real values via your platform's own secrets manager
# at deploy time (see DEPLOYMENT.md). RELAY_PORT here just matches what
# the app defaults to if unset, so EXPOSE documents the right port.
ENV RELAY_PORT=8787
EXPOSE 8787

CMD ["node", "dist/relay-server/index.js"]
