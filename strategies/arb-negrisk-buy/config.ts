/**
 * ARB-03 NegRisk Multi-condition Buy — Configuration
 *
 * C2/D2 production defaults for the NegRisk multi-leg arbitrage
 * scanner. Category is required — no scan-all mode.
 */

/** Configuration for the ARB-03 NegRisk multi-leg scanner. */
export interface NegRiskBuyConfig {
  /** Required category filter (e.g. "NBA Champion"). */
  category: string;
  /** Platform fee rate per trade (e.g. 0.02 = 2%). */
  feeRate: number;
  /** Flat gas cost per leg in USD (multi-leg pays per-leg gas). */
  gasPerLeg: number;
  /** Minimum net return threshold (e.g. 0.03 = 3%). */
  hurdleRate: number;
  /** Total bankroll in USD. */
  bankroll: number;
  /** Kelly criterion fraction (e.g. 0.15 = 15% of Kelly). */
  kellyFraction: number;
  /** Max total-bundle exposure as fraction of bankroll (all legs combined). */
  maxExposure: number;
  /** Signal time-to-live in milliseconds (multi-leg needs more buffer). */
  signalTtlMs: number;
  /** Minimum per-leg liquidity in USD — bundle rejected if any leg below. */
  minLegLiquidity: number;
  /** Price cap for legs below `lowLiqThreshold` — rejects thin high-price legs. */
  maxLegPriceWithLowLiq: number;
  /** Liquidity level that triggers the low-liq price cap. */
  lowLiqThreshold: number;
  /** Confluence: sum threshold below which the "strong signal" gate passes. */
  sumThreshold: number;
}

/** C2/D2 production defaults for ARB-03 NegRisk multi-leg arbitrage. */
export const DEFAULT_NEGRISK_BUY_CONFIG: NegRiskBuyConfig = {
  category: "NBA Champion",
  feeRate: 0.02,
  gasPerLeg: 0.05,
  hurdleRate: 0.03,
  bankroll: 10_000,
  kellyFraction: 0.15,
  maxExposure: 0.05,
  signalTtlMs: 15_000,
  minLegLiquidity: 300,
  maxLegPriceWithLowLiq: 0.30,
  lowLiqThreshold: 100,
  sumThreshold: 0.97,
};
