/**
 * TRADE-02 Momentum Trading — Configuration
 *
 * Scanner-only template: detects price-momentum entries in the
 * [0.10, 0.30] probability band with confluence from volume, RSI, MACD,
 * and open-interest trend. No execution (dry-run emit via runner.ts).
 *
 * Defaults sourced from C2 (strategy spec) and D2 (config injection).
 */

/** TRADE-02 momentum-trading configuration. */
export interface TradeMomentumConfig {
  /** Optional category filter — `undefined` scans all markets. */
  category?: string;
  /** Fractional Kelly multiplier applied to full-Kelly size. */
  kellyFraction: number;
  /** Max share of bankroll per position. */
  maxExposure: number;
  /** Max concurrent open positions (bankroll exposure ceiling). */
  maxConcurrent: number;
  /** Minimum gross edge required after fees, gas, slippage. */
  hurdleRateGross: number;
  /** Platform fee per trade. */
  feeRate: number;
  /** Flat gas cost per signal (USD). */
  gasCost: number;
  /** Assumed slippage per trade. */
  slippage: number;
  /** Lower bound of entry price band (inclusive). */
  entryMinPrice: number;
  /** Upper bound of entry price band (inclusive). */
  entryMaxPrice: number;
  /** Target exit price used for expected-edge calculations. */
  exitTargetPrice: number;
  /** Minimum period-over-period price delta for confluence (a). */
  deltaPriceThreshold: number;
  /** Minimum volume percentile for confluence (a). */
  volPercentileThreshold: number;
  /** Signal time-to-live (ms). */
  signalTtlMs: number;
  /** Hard-stop floor: never operate with `timeToClose < this`. */
  minTimeToCloseHours: number;
  /** Preferred runway before market close. */
  preferredTimeToCloseDays: number;
  /** Manipulation guard: reject if any wallet exceeds this share of volume. */
  maxTopWalletShare: number;
  /** RSI smoothing window (Wilder). */
  rsiWindow: number;
  /** MACD fast EMA period. */
  macdFast: number;
  /** MACD slow EMA period. */
  macdSlow: number;
  /** MACD signal EMA period. */
  macdSignalPeriod: number;
  /** Rolling window used for volume-percentile computation. */
  volumeWindow: number;
  /** Per-market rolling-history cap (periods retained). */
  historyCap: number;
  /** Total available bankroll (USD). */
  bankroll: number;
}

/** C2/D2 production defaults for TRADE-02. */
export const DEFAULT_TRADE_MOMENTUM_CONFIG: TradeMomentumConfig = {
  kellyFraction: 0.30,
  maxExposure: 0.10,
  maxConcurrent: 3,
  hurdleRateGross: 0.05,
  feeRate: 0.02,
  gasCost: 0.02,
  slippage: 0.005,
  entryMinPrice: 0.10,
  entryMaxPrice: 0.30,
  exitTargetPrice: 0.50,
  deltaPriceThreshold: 0.08,
  volPercentileThreshold: 80,
  signalTtlMs: 120_000,
  minTimeToCloseHours: 24,
  preferredTimeToCloseDays: 14,
  maxTopWalletShare: 0.80,
  rsiWindow: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignalPeriod: 9,
  volumeWindow: 20,
  historyCap: 50,
  bankroll: 10_000,
};
