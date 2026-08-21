import { ethers } from "hardhat";

/**
 * Off-chain reimplementation of Uniswap v4-periphery's `HookMiner.find()`
 * (Solidity, @uniswap/v4-periphery/src/utils/HookMiner.sol) — same EIP-1014
 * CREATE2 address formula, same masking against the low 14 bits, just done
 * in TypeScript instead of as thousands of on-chain view calls (which would
 * mean thousands of eth_call round-trips; this is the same computation done
 * locally in milliseconds instead).
 *
 * `deployer` must be the actual address that will perform the CREATE2
 * deployment — here, always a `Create2Factory` instance's own address
 * (since `Create2Factory.deploy` uses inline-assembly `create2` from
 * `address(this)`), never an EOA.
 */

const ALL_HOOK_MASK = (1n << 14n) - 1n;

export const HookFlags = {
  BEFORE_INITIALIZE: 1n << 13n,
  AFTER_INITIALIZE: 1n << 12n,
  BEFORE_ADD_LIQUIDITY: 1n << 11n,
  AFTER_ADD_LIQUIDITY: 1n << 10n,
  BEFORE_REMOVE_LIQUIDITY: 1n << 9n,
  AFTER_REMOVE_LIQUIDITY: 1n << 8n,
  BEFORE_SWAP: 1n << 7n,
  AFTER_SWAP: 1n << 6n,
  BEFORE_DONATE: 1n << 5n,
  AFTER_DONATE: 1n << 4n,
} as const;

export interface MinedHook {
  address: string;
  salt: string;
  initCode: string;
}

/**
 * @param deployerAddress  the Create2Factory address that will actually
 *                          perform the deployment.
 * @param flags             bitwise-OR of the desired HookFlags.
 * @param creationCode      contract creation bytecode (from Hardhat's
 *                          artifact, e.g. `artifact.bytecode`).
 * @param constructorArgsEncoded  ABI-encoded constructor arguments, e.g.
 *                          `iface.encodeDeploy([...args])`.
 * @param maxIterations     mirrors HookMiner.sol's own MAX_LOOP (160_444),
 *                          same ceiling so behaviour matches the Solidity
 *                          reference implementation.
 */
export function mineHookAddress(
  deployerAddress: string,
  flags: bigint,
  creationCode: string,
  constructorArgsEncoded: string,
  maxIterations = 160_444
): MinedHook {
  const wantedFlags = flags & ALL_HOOK_MASK;
  const initCode = ethers.concat([creationCode, constructorArgsEncoded]);
  const initCodeHash = ethers.keccak256(initCode);

  for (let i = 0; i < maxIterations; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const address = ethers.getCreate2Address(deployerAddress, salt, initCodeHash);
    if ((BigInt(address) & ALL_HOOK_MASK) === wantedFlags) {
      return { address, salt, initCode };
    }
  }
  throw new Error(`HookMiner: could not find a salt within ${maxIterations} iterations`);
}
