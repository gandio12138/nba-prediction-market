/**
 * IA-03 Fair Value Probability Model — Configuration
 *
 * Scanner-only template: computes a per-market fair-value probability
 * via a pluggable statistical `ProbabilityModel`, emits divergence
 * candidates whenever `|fairValue − marketPrice|` clears the
 * `minDivergencePp` threshold. No execution (dry-run emit via
 * runner.ts). Inputs are numeric only — NO news, NLP, sentiment, or
 * LLM calls.
 */

/** IA-03 fair-value divergence scanner configuration. */
export interface FairValueConfig {
  /** Optional category filter — `undefined` scans all markets. */
  category?: string;
  /** Fractional Kelly multiplier applied to full-Kelly size. */
  kellyHaircut: number;
  /** Max share of bankroll per single open position. */
  maxExposurePerPosition: number;
  /** Max concurrent open positions (portfolio exposure ceiling). */
  maxConcurrent: number;
  /** Minimum |fair − market| divergence, in probability points. */
  minDivergencePp: number;
  /** Divergence at/above this triggers full-Kelly tier. */
  fullTierDivergencePp: number;
  /** Minimum 24h USD volume to consider a market liquid. */
  minVolume24h: number;
  /** Minimum USD open interest to consider a market liquid. */
  minOpenInterest: number;
  /** Signal time-to-live (ms). Stale signals are rejected. */
  signalTtlMs: number;
  /** Hard-stop floor: reject any market closing in under this many days. */
  minTimeToCloseDays: number;
  /** Preferred runway before market close. */
  preferredTimeToCloseDays: number;
  /** Minimum number of model sources required for the confluence gate. */
  minSources: number;
  /** Total available bankroll (USD). */
  bankroll: number;
}

/** C2/D2 production defaults for IA-03. */
export const DEFAULT_FAIR_VALUE_CONFIG: FairValueConfig = {
  kellyHaircut: 0.25,
  maxExposurePerPosition: 0.10,
  maxConcurrent: 5,
  minDivergencePp: 0.05,
  fullTierDivergencePp: 0.08,
  minVolume24h: 5_000,
  minOpenInterest: 3_000,
  signalTtlMs: 24 * 60 * 60 * 1000,
  minTimeToCloseDays: 7,
  preferredTimeToCloseDays: 30,
  minSources: 2,
  bankroll: 10_000,
};
