/**
 * TRADE-02 Momentum Trading — Signal Detection
 *
 * Pure functions that compute per-market momentum indicators (RSI, MACD,
 * volume percentile, OI trend) and evaluate whether a given snapshot of
 * a market meets the TRADE-02 confluence + guard criteria.
 */

import type { TradeMomentumConfig } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Snapshot passed to `evaluateMomentumOpportunity`. */
export interface MomentumSnapshot {
  /** Platform market identifier (Polymarket conditionId). */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** Mid-price history (oldest → newest). Last element is current. */
  priceHistory: number[];
  /** Volume history (oldest → newest). Last element is current. */
  volumeHistory: number[];
  /** Open-interest history (oldest → newest). Optional. */
  oiHistory?: number[];
  /** Largest wallet's share of recent volume. */
  topWalletShare: number;
  /** Time until market close (ms). */
  timeToCloseMs: number;
}

/** Output of `evaluateMomentumOpportunity`. */
export interface MomentumSignal {
  /** Whether this market passes confluence + guards. */
  viable: boolean;
  /** Current-period mid-price change. */
  deltaPrice: number;
  /** Rolling-window volume percentile for current volume. */
  volumePercentile: number;
  /** Wilder RSI at the current period. */
  rsi: number;
  /** True if MACD crossed above signal at this period. */
  macdCrossUp: boolean;
  /** Direction of open interest over the available series. */
  oiTrend: "rising" | "flat" | "falling" | "unknown";
  /** How many of the 4 confluence criteria fired (a, b, c, d). */
  confluenceCount: number;
  /** Projected net return to the target exit price. */
  projectedNet: number;
  /** Rejection reason when `viable` is false. */
  reason?: string;
}

/** Wilder-smoothed RSI over the last `window` periods of deltas. */
export function computeRSI(prices: number[], window: number): number {
  if (prices.length < 2) return 50;
  const deltas: number[] = [];
  for (let i = 1; i < prices.length; i += 1) {
    deltas.push(prices[i]! - prices[i - 1]!);
  }
  const effectiveWindow = Math.min(window, deltas.length);
  const recent = deltas.slice(-effectiveWindow);
  let gainSum = 0;
  let lossSum = 0;
  for (const delta of recent) {
    if (delta > 0) gainSum += delta;
    else lossSum -= delta;
  }
  const avgGain = gainSum / effectiveWindow;
  const avgLoss = lossSum / effectiveWindow;
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Exponential moving average series for the given period. */
function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  if (values.length === 0) return result;
  const k = 2 / (period + 1);
  let prev = values[0]!;
  result.push(prev);
  for (let i = 1; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

/** MACD (fast EMA − slow EMA) with signal-line EMA and cross-up flag. */
export function computeMACD(
  prices: number[],
  fast: number,
  slow: number,
  signalPeriod: number,
): {
  macd: number;
  signal: number;
  histogram: number;
  crossedUpThisPeriod: boolean;
} {
  if (prices.length === 0) {
    return { macd: 0, signal: 0, histogram: 0, crossedUpThisPeriod: false };
  }
  const fastEma = ema(prices, fast);
  const slowEma = ema(prices, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < prices.length; i += 1) {
    macdLine.push(fastEma[i]! - slowEma[i]!);
  }
  const signalLine = ema(macdLine, signalPeriod);
  const macd = macdLine[macdLine.length - 1]!;
  const signal = signalLine[signalLine.length - 1]!;
  const prevMacd = macdLine[macdLine.length - 2] ?? macd;
  const prevSignal = signalLine[signalLine.length - 2] ?? signal;
  const crossedUpThisPeriod = prevMacd <= prevSignal && macd > signal;
  return { macd, signal, histogram: macd - signal, crossedUpThisPeriod };
}

/** Percentile rank of `value` in `history` (0–100). */
export function computeVolumePercentile(
  history: number[],
  value: number,
): number {
  if (history.length === 0) return 0;
  let countLess = 0;
  for (const h of history) {
    if (h < value) countLess += 1;
  }
  const denom = Math.max(1, history.length - 1);
  const pct = (countLess / denom) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Inspect OI series: rising, flat, falling, or unknown. */
function computeOiTrend(
  oiHistory: number[] | undefined,
): "rising" | "flat" | "falling" | "unknown" {
  if (!oiHistory || oiHistory.length < 2) return "unknown";
  const first = oiHistory[0]!;
  const last = oiHistory[oiHistory.length - 1]!;
  const diff = last - first;
  const eps = Math.max(Math.abs(first) * 0.001, 1e-9);
  if (diff > eps) return "rising";
  if (diff < -eps) return "falling";
  return "flat";
}

/**
 * Evaluate a market snapshot against the TRADE-02 confluence gate and
 * manipulation / entry guards.
 *
 * Guards (ordered): entry-band → wallet concentration → preferred runway
 * → OI direction. Confluence is computed regardless, then the viable
 * flag depends on ≥2 of 4 criteria firing.
 */
export function evaluateMomentumOpportunity(
  snapshot: MomentumSnapshot,
  config: TradeMomentumConfig,
): MomentumSignal {
  const {
    priceHistory,
    volumeHistory,
    oiHistory,
    topWalletShare,
    timeToCloseMs,
  } = snapshot;

  const currentPrice =
    priceHistory.length > 0 ? priceHistory[priceHistory.length - 1]! : 0;
  const prevPrice =
    priceHistory.length > 1
      ? priceHistory[priceHistory.length - 2]!
      : currentPrice;
  const deltaPrice = currentPrice - prevPrice;

  const currentVolume =
    volumeHistory.length > 0
      ? volumeHistory[volumeHistory.length - 1]!
      : 0;
  const volWindow = volumeHistory.slice(-config.volumeWindow);
  const volumePercentile = computeVolumePercentile(volWindow, currentVolume);

  const rsi = computeRSI(priceHistory, config.rsiWindow);
  const rsiPrev =
    priceHistory.length > 1
      ? computeRSI(priceHistory.slice(0, -1), config.rsiWindow)
      : rsi;
  const rsiRising = rsi >= rsiPrev;

  const macd = computeMACD(
    priceHistory,
    config.macdFast,
    config.macdSlow,
    config.macdSignalPeriod,
  );
  const macdCrossUp = macd.crossedUpThisPeriod;

  const oiTrend = computeOiTrend(oiHistory);

  // Confluence criteria
  let confluenceCount = 0;
  if (
    deltaPrice > config.deltaPriceThreshold &&
    volumePercentile >= config.volPercentileThreshold
  ) {
    confluenceCount += 1;
  }
  if (rsi > 60 && rsiRising) confluenceCount += 1;
  if (macdCrossUp) confluenceCount += 1;

  const priorVol = volumeHistory.slice(-11, -1);
  if (priorVol.length > 0) {
    const avgPrior =
      priorVol.reduce((sum, v) => sum + v, 0) / priorVol.length;
    if (avgPrior > 0 && currentVolume > 2 * avgPrior) {
      confluenceCount += 1;
    }
  }

  const projectedNet =
    currentPrice > 0
      ? (config.exitTargetPrice - currentPrice) / currentPrice
      : 0;

  const base = {
    deltaPrice,
    volumePercentile,
    rsi,
    macdCrossUp,
    oiTrend,
    confluenceCount,
    projectedNet,
  };

  if (
    currentPrice < config.entryMinPrice ||
    currentPrice > config.entryMaxPrice
  ) {
    return {
      ...base,
      viable: false,
      reason: `Entry price ${currentPrice.toFixed(4)} outside band`
        + ` [${config.entryMinPrice}, ${config.entryMaxPrice}]`,
    };
  }

  if (topWalletShare > config.maxTopWalletShare) {
    return {
      ...base,
      viable: false,
      reason: `Wallet concentration manipulation guard:`
        + ` topWalletShare=${topWalletShare.toFixed(3)}`
        + ` > ${config.maxTopWalletShare}`,
    };
  }

  const preferredMs = config.preferredTimeToCloseDays * DAY_MS;
  if (timeToCloseMs < preferredMs) {
    return {
      ...base,
      viable: false,
      reason: `timeToClose ${Math.round(timeToCloseMs / DAY_MS)}d`
        + ` below preferred runway ${config.preferredTimeToCloseDays}d`,
    };
  }

  if (oiTrend === "falling") {
    return {
      ...base,
      viable: false,
      reason: "Open-interest falling while price rising (manipulation guard)",
    };
  }

  if (confluenceCount < 2) {
    return {
      ...base,
      viable: false,
      reason: `Insufficient confluence: ${confluenceCount}/4 criteria fired`,
    };
  }

  return { ...base, viable: true };
}
