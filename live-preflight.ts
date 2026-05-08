/**
 * Shared `--live` start-up safety gate.
 *
 * Every strategy that posts real orders runs the same three checks
 * before its poll loop starts:
 *
 *   1. The pmxt sidecar advertises the time-in-force the strategy
 *      depends on (GTC / FOK / IOC). Silent degradation here changes
 *      strategy semantics — a FOK arb leg becomes one-sided, a GTC
 *      passive entry becomes an aggressive taker.
 *
 *   2. The Polymarket onboarding adapter reports
 *      funder-deployed / approvals-ready / creds-ready / collateral > 0.
 *      Each missing flag maps to a specific
 *      `canon-cli onboard --execute` invocation so the operator gets
 *      a remediation, not a downstream signing failure.
 *
 *   3. (Optional) An auth-side smoke (e.g. `fetchBalance`) so a stale
 *      `WALLET_PRIVATE_KEY` surfaces here with a clear message instead
 *      of crashing on the first reconcile cycle.
 *
 * Strategies pass their identity (`strategyName`, `requiredTif`) and an
 * optional `authSmoke` callback. Everything else is shared.
 */

import { getCapabilities } from "./client-polymarket.js";
import { getWalletPrivateKey } from "./env.js";
import { polymarketOnboard } from "./polymarket-onboard.js";

export interface PreflightOptions {
  /** Human label for error messages (e.g. "TRADE-02", "ARB-01"). */
  strategyName: string;
  /** Time-in-force the strategy depends on (e.g. "GTC", "FOK"). */
  requiredTif: string;
  /**
   * Strategy-specific reason for the TIF requirement, appended to the
   * "refusing to run" error. Optional — strategies that don't carry a
   * follow-up reference can omit it.
   */
  tifReason?: string;
  /**
   * Optional auth-smoke callback. Returns a one-line summary string
   * that will be written to stdout on success. Throws to surface the
   * underlying credential / network failure with the strategy's prefix.
   */
  authSmoke?: () => Promise<{ summary: string }>;
}

/**
 * Run every gate above. Throws on any failure with an actionable error.
 *
 * Skips the onboarding gate when no `WALLET_PRIVATE_KEY` is configured
 * (orchestrator dry-run path) — the strategy's own dry-run guard
 * decides whether that's acceptable.
 */
export async function assertReadyForLive(
  opts: PreflightOptions,
): Promise<void> {
  const caps = await getCapabilities();
  if (!caps.supportsTif) {
    const suffix = opts.tifReason ? ` ${opts.tifReason}` : "";
    throw new Error(
      `${opts.strategyName} --live: pmxt sidecar does not advertise ` +
        `${opts.requiredTif} time-in-force support; refusing to run.${suffix}`,
    );
  }

  const pk = getWalletPrivateKey();
  if (pk !== undefined && pk.length > 0) {
    const status = await polymarketOnboard.build(pk).status();
    const blockers = collectOnboardBlockers(status);
    if (blockers.length > 0) {
      throw new Error(
        `${opts.strategyName} --live: Polymarket wallet is not onboarded:\n  - ` +
          blockers.join("\n  - "),
      );
    }
    process.stdout.write(
      `${opts.strategyName} --live: onboard ready, ` +
        `funder=${status.funderAddress} ` +
        `collateral=${String(status.fundedCollateral)}\n`,
    );
  }

  if (opts.authSmoke) {
    try {
      const result = await opts.authSmoke();
      process.stdout.write(`${opts.strategyName} --live: ${result.summary}\n`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${opts.strategyName} --live: auth smoke failed: ${msg}. ` +
          "Verify WALLET_PRIVATE_KEY (and run " +
          "`canon-cli onboard --execute --venue polymarket` " +
          "if creds are missing).",
      );
    }
  }
}

interface OnboardStatusShape {
  funderDeployed: boolean;
  approvalsReady: boolean;
  credsReady: boolean;
  fundedCollateral: number;
  funderAddress: string;
}

function collectOnboardBlockers(status: OnboardStatusShape): string[] {
  const blockers: string[] = [];
  if (!status.funderDeployed) {
    blockers.push(
      `funder Safe is not deployed at ${status.funderAddress} — ` +
        "run `canon-cli onboard --execute --venue polymarket`",
    );
  } else if (status.fundedCollateral <= 0) {
    blockers.push(
      `funder ${status.funderAddress} holds no collateral — ` +
        "send native USDC to the EOA and run " +
        "`canon-cli onboard --execute --fund --venue polymarket`",
    );
  }
  if (!status.approvalsReady) {
    blockers.push(
      "CLOB spender approvals are missing — " +
        "run `canon-cli onboard --execute --venue polymarket`",
    );
  }
  if (!status.credsReady) {
    blockers.push(
      "CLOB API credentials are not derivable — " +
        "run `canon-cli onboard --execute --venue polymarket`",
    );
  }
  return blockers;
}
