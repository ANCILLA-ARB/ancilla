// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Nothing in Ancilla's own contracts imports the *concrete* PoolManager —
// only its interface. Hardhat only compiles a file (and whatever it
// imports) if something under contracts/ actually references it, so
// without this file PoolManager would never get compiled at all and no
// local Hardhat network test could deploy a real pool manager to test
// against. Exists purely to pull it into the compilation graph — never
// imported or referenced by anything else in this repo. (An earlier
// version of this file also force-compiled Uniswap's own
// PoolModifyLiquidityTest test utility for seeding demo liquidity —
// replaced by this repo's own AncillaLiquidityRouter instead, so every
// contract this repo actually deploys, in tests or live, is self-authored
// and MIT-licensed, not borrowed from Uniswap's UNLICENSED test tooling.)
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
