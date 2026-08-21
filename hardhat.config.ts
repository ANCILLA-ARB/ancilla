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
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
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
