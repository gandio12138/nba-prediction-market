/**
 * MINT-01 Simple Mint Cycle — Configuration
 *
 * One MINT-01 cycle:
 *   1. `splitPosition($1,000 USDC.e)` → mints matched YES + NO outcome tokens.
 *   2. Place two GTC sell limit orders at `midpoint + 0.75¢` on each leg.
 *   3. Wait up to 24h for fills; cancel + exit if midpoint drifts > 5¢.
 *
 * Capital sizing is fixed at $1,000 per cycle — no Kelly sizing, no
 * per-market scaling. Exposure is bounded by `maxExposure` (20% of
 * bankroll) spread across distinct markets.
 *
 * Defaults sourced from the C2 strategy spec. The hurdle figure
 * (~$13/cycle net) matches the MINT-04 projection in `mm-premium`,
 * since MINT-01 and MINT-04 share the same +0.75¢ premium math.
 */
import { CONDITIONAL_TOKENS_ADDRESS } from "../../polygon-addresses.js";

/** Configuration shape for the MINT-01 simple mint cycle. */
export interface Mint01Config {
  /** Total available bankroll (USD). */
  bankroll: number;
  /** Capital deployed per cycle (USD). Fixed at $1,000 by spec. */
  cycleCapital: number;
  /** Max share of bankroll allowed in active MINT-01 cycles (0-1). */
  maxExposure: number;
  /** Premium offset above midpoint for sell legs, in dollars (0.75¢ = 0.0075). */
  premiumOffset: number;
  /**
   * Stop-loss drift threshold in dollars. If `|currentMidpoint − entryMidpoint|`
   * exceeds this value, both legs are cancelled and the cycle exits.
   */
  stopLossDrift: number;
  /** Minimum net-USD return per cycle required to pass the hurdle gate. */
  hurdlePerCycle: number;
  /** Flat fee per $1,000 cycle (USD). */
  feePerCycle: number;
  /** Flat gas cost per cycle (USD). */
  gasPerCycle: number;
  /** LP rebate credited per $1,000 cycle (USD). */
  lpRebatePerCycle: number;
  /** Market filter: minimum 24h volume in USD. */
  minVolume24h: number;
  /** Market filter: minimum open interest in USD. */
  minOpenInterest: number;
  /** Market filter: minimum time-to-close in milliseconds. */
  minTimeToCloseMs: number;
  /** Maximum duration to keep an unfilled cycle open before forcing reconcile. */
  maxCycleDurationMs: number;
  /** Time-in-force for the sell legs. GTC matches the 24h cycle by default. */
  timeInForce: "GTC" | "FOK";
  /** Polygon ConditionalTokens contract used for `splitPosition`. */
  conditionalTokensAddress: string;
}

/** C2 production defaults for MINT-01. */
export const DEFAULT_MINT_01_CONFIG: Mint01Config = {
  bankroll: 10_000,
  cycleCapital: 1_000,
  maxExposure: 0.2,
  premiumOffset: 0.0075,
  stopLossDrift: 0.05,
  hurdlePerCycle: 13,
  feePerCycle: 1.7,
  gasPerCycle: 0.05,
  lpRebatePerCycle: 0.325,
  minVolume24h: 10_000,
  minOpenInterest: 5_000,
  minTimeToCloseMs: 48 * 60 * 60 * 1000,
  maxCycleDurationMs: 24 * 60 * 60 * 1000,
  timeInForce: "GTC",
  conditionalTokensAddress: CONDITIONAL_TOKENS_ADDRESS,
};

/**
 * Maximum number of concurrent MINT-01 cycles allowed by the bankroll cap.
 *
 * `floor((bankroll * maxExposure) / cycleCapital)`. With the defaults
 * (10k * 20% / 1k) this yields 2 concurrent cycles across distinct markets.
 */
export function maxConcurrentCycles(
  config: Mint01Config = DEFAULT_MINT_01_CONFIG,
): number {
  return Math.floor((config.bankroll * config.maxExposure) / config.cycleCapital);
}

/**
 * Projected net profit per cycle in USD at the configured premium.
 *
 * `gross − fees − gas + lpRebate`. `gross` is derived from the premium
 * offset: at +0.75¢ on a $1,000 mint both legs gross 0.75¢ * size each,
 * for $15 total. Scaled linearly by `cycleCapital / 1_000`.
 */
export function projectedNetPerCycle(
  config: Mint01Config = DEFAULT_MINT_01_CONFIG,
): number {
  const capitalRatio = config.cycleCapital / 1_000;
  const grossPerLeg = config.premiumOffset * config.cycleCapital;
  const gross = grossPerLeg * 2;
  return gross - config.feePerCycle * capitalRatio - config.gasPerCycle
    + config.lpRebatePerCycle * capitalRatio;
}
