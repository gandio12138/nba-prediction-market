/**
 * MINT-04 Market Making Premium — Configuration
 *
 * Scanner-only template: detects markets where minting $1 sets and posting
 * paired limit sells at midpoint ± offset is viable. No execution (no
 * `mint_set`, no `postLimitOrder`).
 *
 * Defaults sourced from C2 (strategy spec) and D2 (config injection).
 */

/** MINT-04 market-making premium configuration. */
export interface MintPremiumConfig {
  /** Kelly fraction for position sizing. */
  kellyFraction: number;
  /** Max share of bankroll allowed in active cycles. */
  maxExposure: number;
  /** Minimum net-return per cycle required to pass the hurdle gate. */
  hurdleRate: number;
  /** Flat fee per $1,000 cycle (USD). */
  feeRate: number;
  /** Flat gas cost per cycle (USD). */
  gasCost: number;
  /** LP rebate credited per $1,000 cycle (USD). */
  lpRebate: number;
  /** Gross revenue per $1,000 cycle at default offset (USD). */
  grossPerCycle: number;
  /** Capital deployed per cycle (USD). */
  cycleCapital: number;
  /** Default offset in cents for mid-volume markets. */
  offsetDefaultC: number;
  /** Aggressive offset in cents for high-volume markets. */
  offsetAggressiveC: number;
  /** Fallback offset when per-leg activity is low. */
  offsetDefensiveC: number;
  /** Confluence threshold — volume_24h (USD). */
  volume24hThreshold: number;
  /** Confluence threshold — trades per hour. */
  trades1hThreshold: number;
  /** Confluence threshold — max bid-ask spread. */
  spreadThreshold: number;
  /** Volume bracket above which the aggressive offset is selected. */
  volumeAggressiveThreshold: number;
  /** Volume floor below which MINT-02 downgrade is advised. */
  volumeDowngradeThreshold: number;
  /** Minimum trades/hour per leg before a low-activity warning fires. */
  minTradesPerHour: number;
  /** Market-close cutoff (ms) — reject cycles below. */
  timeToCloseRejectMs: number;
  /** Short-cycle adjustment window (ms) — between reject and full. */
  timeToCloseAdjustMs: number;
  /** Signal time-to-live (ms). */
  signalTtlMs: number;
  /** Total available bankroll (USD). */
  bankroll: number;
}

/** C2/D2 production defaults for MINT-04. */
export const DEFAULT_MM_PREMIUM_CONFIG: MintPremiumConfig = {
  kellyFraction: 1.0,
  maxExposure: 0.25,
  hurdleRate: 0.0133,
  feeRate: 0.0017,
  gasCost: 0.05,
  lpRebate: 0.325,
  grossPerCycle: 15,
  cycleCapital: 1_000,
  offsetDefaultC: 0.0075,
  offsetAggressiveC: 0.01,
  offsetDefensiveC: 0.005,
  volume24hThreshold: 20_000,
  trades1hThreshold: 10,
  spreadThreshold: 0.015,
  volumeAggressiveThreshold: 50_000,
  volumeDowngradeThreshold: 10_000,
  minTradesPerHour: 3,
  timeToCloseRejectMs: 24 * 60 * 60 * 1000,
  timeToCloseAdjustMs: 48 * 60 * 60 * 1000,
  signalTtlMs: 6 * 60 * 60 * 1000,
  bankroll: 10_000,
};

/**
 * Projected net profit per $1,000 cycle at default offset, in USD.
 *
 * bruto ($15) − fees ($1.70) − gas ($0.05) + lp ($0.325) = $13.575.
 * Fees are quoted flat per $1,000 in the source spec, so they are scaled
 * linearly by cycle capital and converted to USD here.
 */
export function projectedNetPerCycle(
  config: MintPremiumConfig = DEFAULT_MM_PREMIUM_CONFIG,
): number {
  const capitalRatio = config.cycleCapital / 1_000;
  const fees = config.feeRate * 1_000 * capitalRatio;
  const lp = config.lpRebate * capitalRatio;
  const gross = config.grossPerCycle * capitalRatio;
  return gross - fees - config.gasCost + lp;
}
