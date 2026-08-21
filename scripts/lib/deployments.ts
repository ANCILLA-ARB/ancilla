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
export function loadIntentCommitRevealDeployment(networkName: string): IntentCommitRevealDeployment {
  const deploymentsPath = path.join(__dirname, "..", "..", "deployments", `${networkName}.json`);
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error(
      `${deploymentsPath} not found — run \`npx hardhat run scripts/deploy.ts --network ${networkName}\` first`
    );
  }
  const data = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const entry = data?.contracts?.IntentCommitReveal;
  if (!entry?.address) {
    throw new Error(`${deploymentsPath} has no contracts.IntentCommitReveal entry`);
  }
  return entry as IntentCommitRevealDeployment;
}
