import * as fs from "fs";
import * as path from "path";

export interface IntentCommitRevealDeployment {
  address: string;
  commitWindowSeconds: number;
  revealDelaySeconds: number;
  revealWindowSeconds: number;
  minBond: string;
  treasury: string;
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
