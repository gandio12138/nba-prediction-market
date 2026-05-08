/**
 * MINT-04 Market Making Premium — Scan Layer
 *
 * Fetches market snapshots via an injected `fetchSnapshots` dep and applies
 * the market-close cutoff (drop markets whose `timeToCloseMs` is below
 * `config.timeToCloseRejectMs`). Volume and confluence filtering is left to
 * `signal.ts` so low-volume markets can still surface a MINT-02 advisory.
 */

import type { MintPremiumConfig } from "./config.js";
import type { MintPremiumSnapshot } from "./signal.js";

/** Injectable dependencies for the scan layer. */
export interface ScanDeps {
  /** Fetch the current set of market snapshots. */
  fetchSnapshots: () => Promise<MintPremiumSnapshot[]>;
}

/**
 * Scan markets and apply the market-close cutoff.
 *
 * Snapshots with `timeToCloseMs < config.timeToCloseRejectMs` are dropped.
 * All other fields flow through unchanged so the signal layer can evaluate
 * the full confluence / volume / spread picture.
 */
export async function scanMarkets(
  config: MintPremiumConfig,
  deps: ScanDeps,
): Promise<MintPremiumSnapshot[]> {
  const snapshots = await deps.fetchSnapshots();
  const cutoff = config.timeToCloseRejectMs;

  const kept: MintPremiumSnapshot[] = [];
  for (const snap of snapshots) {
    if (snap.timeToCloseMs >= cutoff) {
      kept.push(snap);
    }
  }
  return kept;
}
