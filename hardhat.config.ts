import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-contract-sizer";
import * as dotenv from "dotenv";

dotenv.config({ quiet: true }); // quiet: true also silences dotenv's promotional "tip" log line

const ARBITRUM_SEPOLIA_RPC = process.env.ARBITRUM_SEPOLIA_RPC || "https://sepolia-rollup.arbitrum.io/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARBISCAN_API_KEY = process.env.ARBISCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    // Two compilers on purpose: every Ancilla-authored contract is pinned
    // to an exact `pragma solidity 0.8.24;` and stays on 0.8.24. Uniswap
    // v4-core's PoolManager.sol is the one file in the whole v4 dependency
    // tree pinned to an exact `pragma solidity 0.8.26;` (everything else
    // in v4-core/v4-periphery floats — ^0.8.0/^0.8.20/^0.8.24 — so it's
    // satisfied by either). PoolManager itself is only ever deployed by
    // Hardhat's local test network here — the real, live PoolManager on
    // Arbitrum Sepolia/One is already deployed by Uniswap and is only ever
    // called through its interface, never recompiled.
    // `viaIR: true` on 0.8.24 specifically: AncillaSwapHook's _beforeSwap
    // hit a plain "stack too deep" compiler error (too many locals across
    // the v4 struct/calldata params) — this is the documented, standard
    // fix, not a workaround specific to a bug. 0.8.26 (PoolManager only,
    // never modified here) doesn't need it.
    // `evmVersion: "cancun"` on both: PoolManager's flash accounting uses
    // EIP-1153 transient storage (TSTORE/TLOAD), a Cancun opcode not
    // available under the default "paris" target — compiling for paris
    // either rejects the opcode or produces bytecode that misbehaves at
    // runtime. Arbitrum itself already supports this (the real PoolManager
    // is live and working on both Arbitrum Sepolia and Arbitrum One today
    // — see the project's dossier), so targeting cancun here matches the
    // real deployment target, not just satisfying the local compiler.
    compilers: [
      {
        version: "0.8.24",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
      },
      { version: "0.8.26", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" } },
    ],
  },
  networks: {
    // hardfork: "cancun" so the in-process network actually executes
    // transient-storage opcodes (TSTORE/TLOAD) at runtime, matching what
    // the 0.8.24/0.8.26 compilers above now target — needed for
    // PoolManager's flash accounting in local tests.
    hardhat: { hardfork: "cancun" },
    // Points at a separately-running `npx hardhat node` process (127.0.0.1:8545).
    // Used only to give the relay-server prototype and its E2E test a real,
    // persistent JSON-RPC endpoint to talk to over HTTP — the in-process
    // `hardhat` network above isn't reachable from another process.
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    arbitrumSepolia: {
      url: ARBITRUM_SEPOLIA_RPC,
      chainId: 421614,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  // Source verification on Arbiscan. Requires a free API key from
  // https://etherscan.io/apidashboard (Etherscan's v2 unified API key also
  // works for Arbiscan) — set ARBISCAN_API_KEY in .env. `npm run compile`
  // and tests work fine without it; only `verify` needs it.
  etherscan: {
    apiKey: {
      arbitrumSepolia: ARBISCAN_API_KEY,
    },
    customChains: [
      {
        network: "arbitrumSepolia",
        chainId: 421614,
        urls: {
          apiURL: "https://api-sepolia.arbiscan.io/api",
          browserURL: "https://sepolia.arbiscan.io",
        },
      },
    ],
  },
};

export default config;
