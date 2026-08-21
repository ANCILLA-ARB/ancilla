import * as fs from "fs";
import * as path from "path";

export interface IntentCommitRevealDeployment {
  address: string;
  commitWindowSeconds: number;
  revealDelaySeconds: number;
  revealWindowSeconds: number;
  minBond: string;
  treasury: string;
  guardian?: string;
  slasherRewardBps?: number;
}

/**
 * Reads deployments/<networkName>.json — the single source of truth for
 * "what's actually live where," written by scripts/deploy.ts. Used by every
 * demo script instead of each hardcoding its own copy of the address, which
 * is exactly how scripts/demo.ts, demo-relay.ts, and demo-bond-lock.ts ended
 * up pointing at three different deployments (two of them stale) before
 * this existed.
 */
function readDeploymentsFile(networkName: string): any {
  const deploymentsPath = path.join(__dirname, "..", "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(
      `${deploymentsPath} not found — run \`npx hardhat run scripts/deploy.ts --network ${networkName}\` first`
    );
  }
  return JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
}

export function loadIntentCommitRevealDeployment(networkName: string): IntentCommitRevealDeployment {
  const data = readDeploymentsFile(networkName);
  const entry = data?.contracts?.IntentCommitReveal;
  if (!entry?.address) {
    throw new Error(`deployments/${networkName}.json has no contracts.IntentCommitReveal entry`);
  }
  return entry as IntentCommitRevealDeployment;
}

export interface SwapStackDeployment {
  tokenA: string;
  tokenB: string;
  pool: string;
  executor: string;
}

/** Reads the TestTokenA/TestTokenB/AncillaSwapPool/SwapExecutor entries
 *  written by scripts/deploy-swap.ts, from the same deployments file. */
export function loadSwapStackDeployment(networkName: string): SwapStackDeployment {
  const data = readDeploymentsFile(networkName);
  const { TestTokenA, TestTokenB, AncillaSwapPool, SwapExecutor } = data?.contracts || {};
  if (!TestTokenA?.address || !TestTokenB?.address || !AncillaSwapPool?.address || !SwapExecutor?.address) {
    throw new Error(
      `deployments/${networkName}.json is missing the swap stack — run \`npx hardhat run scripts/deploy-swap.ts --network ${networkName}\` first`
    );
  }
  return {
    tokenA: TestTokenA.address,
    tokenB: TestTokenB.address,
    pool: AncillaSwapPool.address,
    executor: SwapExecutor.address,
  };
}

export interface TreasuryMultisigDeployment {
  address: string;
  owners: string[];
  threshold: number;
}

/** Reads the AncillaTreasuryMultisig entry written by
 *  scripts/deploy-treasury.ts. */
export function loadTreasuryMultisigDeployment(networkName: string): TreasuryMultisigDeployment {
  const data = readDeploymentsFile(networkName);
  const entry = data?.contracts?.AncillaTreasuryMultisig;
  if (!entry?.address) {
    throw new Error(
      `deployments/${networkName}.json has no contracts.AncillaTreasuryMultisig entry — run \`npx hardhat run scripts/deploy-treasury.ts --network ${networkName}\` first`
    );
  }
  return entry as TreasuryMultisigDeployment;
}

export interface GuardianMultisigDeployment {
  address: string;
  owners: string[];
  threshold: number;
}

/** Reads the AncillaGuardianMultisig entry written by
 *  scripts/deploy-guardian.ts. */
export function loadGuardianMultisigDeployment(networkName: string): GuardianMultisigDeployment {
  const data = readDeploymentsFile(networkName);
  const entry = data?.contracts?.AncillaGuardianMultisig;
  if (!entry?.address) {
    throw new Error(
      `deployments/${networkName}.json has no contracts.AncillaGuardianMultisig entry — run \`npx hardhat run scripts/deploy-guardian.ts --network ${networkName}\` first`
    );
  }
  return entry as GuardianMultisigDeployment;
}

export interface TokenStackDeployment {
  token: string;
  timelock: string;
  governor: string;
  staking: string;
}

/** Reads the AncillaToken/AncillaTimelock/AncillaGovernor/AncillaStaking
 *  entries written by scripts/deploy-token.ts. */
export function loadTokenStackDeployment(networkName: string): TokenStackDeployment {
  const data = readDeploymentsFile(networkName);
  const { AncillaToken, AncillaTimelock, AncillaGovernor, AncillaStaking } = data?.contracts || {};
  if (!AncillaToken?.address || !AncillaTimelock?.address || !AncillaGovernor?.address || !AncillaStaking?.address) {
    throw new Error(
      `deployments/${networkName}.json is missing the token/governance stack — run \`npx hardhat run scripts/deploy-token.ts --network ${networkName}\` first`
    );
  }
  return {
    token: AncillaToken.address,
    timelock: AncillaTimelock.address,
    governor: AncillaGovernor.address,
    staking: AncillaStaking.address,
  };
}

export interface VoteEscrowDeployment {
  address: string;
  stakingToken: string;
  minLockSeconds: number;
  maxLockSeconds: number;
}

/** Reads the AncillaVoteEscrow entry written by
 *  scripts/deploy-vote-escrow.ts. */
export function loadVoteEscrowDeployment(networkName: string): VoteEscrowDeployment {
  const data = readDeploymentsFile(networkName);
  const entry = data?.contracts?.AncillaVoteEscrow;
  if (!entry?.address) {
    throw new Error(
      `deployments/${networkName}.json has no contracts.AncillaVoteEscrow entry — run \`npx hardhat run scripts/deploy-vote-escrow.ts --network ${networkName}\` first`
    );
  }
  return entry as VoteEscrowDeployment;
}

export interface AncillaHookDeployment {
  address: string;
  salt: string;
  poolManager: string;
  commitWindowSeconds: number;
  revealDelaySeconds: number;
  revealWindowSeconds: number;
  minBond: string;
  treasury: string;
  guardian?: string;
  slasherRewardBps?: number;
}

export interface AncillaHookPoolKey {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
}

/** Reads the AncillaSwapHook/AncillaHookRouter/AncillaLiquidityRouter/
 *  AncillaHookPool entries written by scripts/deploy-hook.ts. */
export function loadHookDeployment(networkName: string): {
  poolManager: string;
  hook: AncillaHookDeployment;
  router: string;
  liquidityRouter: string;
  poolKey: AncillaHookPoolKey;
} {
  const data = readDeploymentsFile(networkName);
  const { UniswapV4PoolManager, AncillaSwapHook, AncillaHookRouter, AncillaLiquidityRouter, AncillaHookPool } =
    data?.contracts || {};
  if (!AncillaSwapHook?.address || !AncillaHookRouter?.address || !AncillaHookPool) {
    throw new Error(
      `deployments/${networkName}.json is missing the v4 hook stack — run \`npx hardhat run scripts/deploy-hook.ts --network ${networkName}\` first`
    );
  }
  return {
    poolManager: UniswapV4PoolManager.address,
    hook: AncillaSwapHook,
    router: AncillaHookRouter.address,
    liquidityRouter: AncillaLiquidityRouter.address,
    poolKey: AncillaHookPool,
  };
}
