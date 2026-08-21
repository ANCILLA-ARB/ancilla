import { keccak256, AbiCoder, randomBytes, hexlify } from "ethers";

const abiCoder = AbiCoder.defaultAbiCoder();

/**
 * SDK helper an agent operator calls locally, off-chain, before submitting
 * commitIntent(). The salt never leaves the caller's machine until reveal
 * time, which is what keeps the intent content hidden during the commit
 * phase — only the hash goes on-chain up front.
 */
export interface BuiltIntent {
  commitId: string;
  commitHash: string;
  intentData: string;
  salt: string;
}

/**
 * @param agentAddress address that will call commitIntent / revealIntent
 * @param intentData   ABI-encoded payload the executor contract expects
 * @param nonce        caller-supplied uniqueness value for commitId (e.g. an incrementing counter)
 */
export function buildIntent(agentAddress: string, intentData: string, nonce: number | bigint): BuiltIntent {
  const salt = hexlify(randomBytes(32));

  const commitId = keccak256(
    abiCoder.encode(["address", "uint256"], [agentAddress, nonce])
  );

  const commitHash = keccak256(
    abiCoder.encode(["bytes", "bytes32", "address"], [intentData, salt, agentAddress])
  );

  return { commitId, commitHash, intentData, salt };
}

/** Re-derive the same commitHash on-chain would expect, for local sanity checks. */
export function recomputeCommitHash(intentData: string, salt: string, agentAddress: string): string {
  return keccak256(abiCoder.encode(["bytes", "bytes32", "address"], [intentData, salt, agentAddress]));
}
