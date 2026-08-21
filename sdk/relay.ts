import { Signer, keccak256, Signature } from "ethers";

// secp256k1 curve order, and half of it. Verified empirically that ethers'
// signTypedData already always returns canonical low-s signatures (30/30 in
// testing), so this normalization is a defensive no-op for ethers callers —
// kept in case this SDK is ever driven by a different signer implementation
// (hardware wallet, other library) that doesn't canonicalize, since the
// on-chain verifier in IntentCommitReveal rejects high-s as a malleability
// guard and would reject those without this step.
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function toLowS(signature: string): string {
  const sig = Signature.from(signature);
  const sBig = BigInt(sig.s);
  if (sBig <= SECP256K1_HALF_N) return signature; // already canonical
  const flippedS = SECP256K1_N - sBig;
  const flippedV = sig.v === 27 ? 28 : 27;
  const canonical = Signature.from({ r: sig.r, s: "0x" + flippedS.toString(16).padStart(64, "0"), v: flippedV });
  return canonical.serialized;
}

/**
 * EIP-712 signing helper for the relayed-reveal path
 * (IntentCommitReveal.revealIntentViaRelay).
 *
 * The agent signs this off-chain and hands the signature (not their private
 * key, not a transaction) to whichever relay they trust to submit it. The
 * relay pays gas and becomes msg.sender on-chain, but the contract verifies
 * the signature was produced by `agent` before honoring the reveal.
 */
export interface RevealRequestValue {
  commitId: string;
  intentDataHash: string;
  salt: string;
  executor: string;
  agent: string;
  deadline: bigint;
}

export function domainFor(chainId: bigint, verifyingContract: string) {
  return {
    name: "Ancilla",
    version: "1",
    chainId,
    verifyingContract,
  };
}

export const REVEAL_REQUEST_TYPES = {
  RevealRequest: [
    { name: "commitId", type: "bytes32" },
    { name: "intentDataHash", type: "bytes32" },
    { name: "salt", type: "bytes32" },
    { name: "executor", type: "address" },
    { name: "agent", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * @param signer            the agent's own signer (never the relay's)
 * @param chainId            chain the target contract is deployed on
 * @param verifyingContract  the IntentCommitReveal address
 * @param commitId/intentData/salt  same values used at commit time
 * @param executor           executor contract the relay will pass through
 * @param deadlineSecondsFromNow  how long this authorization stays valid
 */
export async function signRevealRequest(
  signer: Signer,
  chainId: bigint,
  verifyingContract: string,
  commitId: string,
  intentData: string,
  salt: string,
  executor: string,
  deadlineSecondsFromNow: number
): Promise<{ value: RevealRequestValue; signature: string }> {
  const agent = await signer.getAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecondsFromNow);

  const value: RevealRequestValue = {
    commitId,
    intentDataHash: keccak256(intentData),
    salt,
    executor,
    agent,
    deadline,
  };

  const rawSignature = await signer.signTypedData(domainFor(chainId, verifyingContract), REVEAL_REQUEST_TYPES, value);
  const signature = toLowS(rawSignature);

  return { value, signature };
}

/**
 * EIP-712 signing helper for the relayed-commit path
 * (IntentCommitReveal.commitIntentViaRelay). Same idea as
 * signRevealRequest: the agent signs off-chain, a relay submits and pays
 * gas, and the contract verifies the signature before recording the
 * commitment against the agent (not the relay).
 */
export interface CommitRequestValue {
  commitId: string;
  commitHash: string;
  agent: string;
  deadline: bigint;
}

export const COMMIT_REQUEST_TYPES = {
  CommitRequest: [
    { name: "commitId", type: "bytes32" },
    { name: "commitHash", type: "bytes32" },
    { name: "agent", type: "address" },
    { name: "deadline", type: "uint256" },
  ],
};

/**
 * @param signer            the agent's own signer (never the relay's)
 * @param chainId            chain the target contract is deployed on
 * @param verifyingContract  the IntentCommitReveal address
 * @param commitId/commitHash  same values that would be used for a direct commitIntent()
 * @param deadlineSecondsFromNow  how long this authorization stays valid
 */
export async function signCommitRequest(
  signer: Signer,
  chainId: bigint,
  verifyingContract: string,
  commitId: string,
  commitHash: string,
  deadlineSecondsFromNow: number
): Promise<{ value: CommitRequestValue; signature: string }> {
  const agent = await signer.getAddress();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSecondsFromNow);

  const value: CommitRequestValue = { commitId, commitHash, agent, deadline };

  const rawSignature = await signer.signTypedData(domainFor(chainId, verifyingContract), COMMIT_REQUEST_TYPES, value);
  const signature = toLowS(rawSignature);

  return { value, signature };
}
