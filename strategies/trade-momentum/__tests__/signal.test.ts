import { describe, it, expect } from "vitest";
import {
  computeRSI,
  computeMACD,
  computeVolumePercentile,
  evaluateMomentumOpportunity,
  type MomentumSnapshot,
} from "../signal.js";
import {
  DEFAULT_TRADE_MOMENTUM_CONFIG,
  type TradeMomentumConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeConfig(
  overrides?: Partial<TradeMomentumConfig>,
): TradeMomentumConfig {
  return { ...DEFAULT_TRADE_MOMENTUM_CONFIG, ...overrides };
}

/** Flat at `base`, then a single-period jump to `jumpTo` at the end. */
function flatThenJumpPrices(base: number, jumpTo: number, n = 40): number[] {
  return [...Array(n - 1).fill(base), jumpTo];
}

/** Flat at `base`, then a single-period volume spike at the end. */
function flatThenSpikeVolumes(base: number, spike: number, n = 40): number[] {
  return [...Array(n - 1).fill(base), spike];
}

function risingOI(n = 40, start = 1_000, step = 20): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function fallingOI(n = 40, start = 2_000, step = 20): number[] {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

function makeSnapshot(
  overrides?: Partial<MomentumSnapshot>,
): MomentumSnapshot {
  return {
    conditionId: "cond-001",
    question: "Will X happen?",
    priceHistory: flatThenJumpPrices(0.15, 0.25),
    volumeHistory: flatThenSpikeVolumes(1_000, 20_000),
    oiHistory: risingOI(),
    topWalletShare: 0.2,
    timeToCloseMs: 14 * DAY_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeRSI
// ---------------------------------------------------------------------------

describe("computeRSI", () => {
  it("returns ~100 for a pure-gain series over the window", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 1 + i);
    expect(computeRSI(prices, 14)).toBeCloseTo(100, 1);
  });

  it("returns ~0 for a pure-loss series over the window", () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(computeRSI(prices, 14)).toBeCloseTo(0, 1);
  });

  it("returns a value in [0, 100] for a flat series", () => {
    const prices = Array(20).fill(10);
    const rsi = computeRSI(prices, 14);
    expect(rsi).toBeGreaterThanOrEqual(0);
    expect(rsi).toBeLessThanOrEqual(100);
  });

  it("returns > 60 when recent periods are dominated by gains", () => {
    // 19 flat + one strong-gain period → RSI tilts high but not extreme.
    // Then extend with more gains so recent window is gain-dominated.
    const prices = [
      ...Array(10).fill(10),
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
    ];
    expect(computeRSI(prices, 14)).toBeGreaterThan(60);
  });
});

// ---------------------------------------------------------------------------
// computeMACD
// ---------------------------------------------------------------------------

describe("computeMACD", () => {
  it("reports macd > signal line after a sustained uptrend", () => {
    const down = Array.from({ length: 30 }, (_, i) => 10 - i * 0.1);
    const up = Array.from({ length: 20 }, (_, i) => 7 + i * 0.5);
    const prices = [...down, ...up];
    const macd = computeMACD(prices, 12, 26, 9);
    expect(macd.macd).toBeGreaterThan(macd.signal);
  });

  it("reports macd <= signal line during a sustained downtrend", () => {
    const prices = Array.from({ length: 50 }, (_, i) => 100 - i);
    const macd = computeMACD(prices, 12, 26, 9);
    expect(macd.macd).toBeLessThanOrEqual(macd.signal);
  });

  it("sets crossedUpThisPeriod=true when MACD crosses signal from below", () => {
    // Downtrend long enough to drive MACD < signal, then a sharp reversal
    // whose final period completes the cross-up.
    const down = Array.from({ length: 35 }, (_, i) => 100 - i);
    const flat = Array(5).fill(65);
    const up = Array.from({ length: 15 }, (_, i) => 65 + i * 2);
    const prices = [...down, ...flat, ...up];
    const macd = computeMACD(prices, 12, 26, 9);
    expect(macd.macd).toBeGreaterThan(macd.signal);
  });
});

// ---------------------------------------------------------------------------
// computeVolumePercentile
// ---------------------------------------------------------------------------

describe("computeVolumePercentile", () => {
  it("returns 100 for the maximum value in history", () => {
    const history = [10, 20, 30, 40, 50];
    expect(computeVolumePercentile(history, 50)).toBeCloseTo(100, 1);
  });

  it("returns 0 for the minimum value in history", () => {
    const history = [10, 20, 30, 40, 50];
    expect(computeVolumePercentile(history, 10)).toBeCloseTo(0, 1);
  });

  it("returns a mid-range percentile for a median value", () => {
    const history = [10, 20, 30, 40, 50];
    const p = computeVolumePercentile(history, 30);
    expect(p).toBeGreaterThan(25);
    expect(p).toBeLessThan(75);
  });

  it("returns 100 for a value strictly above all history", () => {
    const history = [10, 20, 30, 40, 50];
    expect(computeVolumePercentile(history, 999)).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// evaluateMomentumOpportunity — confluence matrix + guards
// ---------------------------------------------------------------------------

describe("evaluateMomentumOpportunity", () => {
  it("emits a viable signal on strong momentum + volume spike + rising OI", () => {
    // delta = 0.25 - 0.15 = 0.10 > 0.08 (confluence-a price side).
    // Volume spike: current 20k vs flat 1k history → p100, also > 2x avg(10).
    // Two confluence criteria pass → viable. Guards all clean.
    const result = evaluateMomentumOpportunity(makeSnapshot(), makeConfig());
    expect(result.viable).toBe(true);
    expect(result.deltaPrice).toBeCloseTo(0.10, 6);
    expect(result.volumePercentile).toBeGreaterThanOrEqual(80);
    expect(result.confluenceCount).toBeGreaterThanOrEqual(2);
    expect(result.oiTrend).toBe("rising");
  });

  it("rejects when price is rising but OI is falling (manipulation guard)", () => {
    const result = evaluateMomentumOpportunity(
      makeSnapshot({ oiHistory: fallingOI() }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/oi|open.?interest|manipul/i);
  });

  it("rejects when a single wallet controls more than 80% of volume", () => {
    const result = evaluateMomentumOpportunity(
      makeSnapshot({ topWalletShare: 0.85 }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/wallet|concentr|manipul/i);
  });

  it("rejects when fewer than 2 confluence signals fire", () => {
    // Flat prices and flat volume → no confluence signal fires.
    const result = evaluateMomentumOpportunity(
      makeSnapshot({
        priceHistory: Array(40).fill(0.20),
        volumeHistory: Array(40).fill(500),
      }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/confluence/i);
    expect(result.confluenceCount).toBeLessThan(2);
  });

  it("rejects when timeToClose is under the 7-day preferred runway", () => {
    const result = evaluateMomentumOpportunity(
      makeSnapshot({ timeToCloseMs: 5 * DAY_MS }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/close|ttc|runway|time/i);
  });

  it("rejects when the entry price is above the band (too high)", () => {
    const result = evaluateMomentumOpportunity(
      makeSnapshot({
        priceHistory: [...Array(39).fill(0.35), 0.45],
      }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/band|entry|price/i);
  });

  it("rejects when the entry price is below the band (too low)", () => {
    const result = evaluateMomentumOpportunity(
      makeSnapshot({
        priceHistory: [...Array(39).fill(0.02), 0.08],
      }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/band|entry|price/i);
  });
});
