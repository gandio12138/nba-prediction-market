import { describe, it, expect } from "vitest";
import { evaluateMintPremiumOpportunity } from "../signal.js";
import type { MintPremiumSnapshot } from "../signal.js";
import {
  DEFAULT_MM_PREMIUM_CONFIG,
  type MintPremiumConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides?: Partial<MintPremiumSnapshot>,
): MintPremiumSnapshot {
  return {
    conditionId: "cond-001",
    question: "Will the Lakers win?",
    midpoint: 0.5,
    volume_24h: 30_000,
    trade_count_1h: 15,
    bid_ask_spread: 0.01,
    timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<MintPremiumConfig>,
): MintPremiumConfig {
  return { ...DEFAULT_MM_PREMIUM_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// evaluateMintPremiumOpportunity
// ---------------------------------------------------------------------------

describe("evaluateMintPremiumOpportunity", () => {
  it("emits viable signal with default +0.75c offset for mid-volume market", () => {
    // volume $30k (in $10k–$50k bracket) → +0.75c offset
    // Confluence: vol>20k ✓, trades>=10 ✓, spread<0.015 ✓ (3/3)
    const snapshot = makeSnapshot({
      volume_24h: 30_000,
      trade_count_1h: 15,
      bid_ask_spread: 0.01,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(true);
    expect(result.offsetC).toBeCloseTo(0.0075, 6);
    expect(result.projectedNet).toBeCloseTo(13.575, 3);
  });

  it("selects +1.0c aggressive offset for high-volume market (>$50k)", () => {
    const snapshot = makeSnapshot({
      volume_24h: 75_000,
      trade_count_1h: 40,
      bid_ask_spread: 0.008,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(true);
    expect(result.offsetC).toBeCloseTo(0.01, 6);
  });

  it("rejects low-volume (<$10k) markets with MINT-02 advisory", () => {
    const snapshot = makeSnapshot({
      volume_24h: 5_000,
      trade_count_1h: 5,
      bid_ask_spread: 0.02,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/MINT-02/i);
  });

  it("rejects when confluence fails (<2 of 3 checks pass)", () => {
    // vol=18k (fails >20k), trades=5 (fails >=10), spread=0.02 (fails <0.015)
    // 0/3 pass → reject
    const snapshot = makeSnapshot({
      volume_24h: 18_000,
      trade_count_1h: 5,
      bid_ask_spread: 0.02,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/confluence/i);
  });

  it("passes when exactly 2 of 3 confluence checks pass", () => {
    // vol=25k ✓, trades=8 ✗, spread=0.01 ✓ (2/3)
    const snapshot = makeSnapshot({
      volume_24h: 25_000,
      trade_count_1h: 8,
      bid_ask_spread: 0.01,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(true);
  });

  it("rejects when only 1 of 3 confluence checks passes", () => {
    // vol=18k ✗, trades=8 ✗, spread=0.01 ✓ (1/3)
    const snapshot = makeSnapshot({
      volume_24h: 18_000,
      trade_count_1h: 8,
      bid_ask_spread: 0.01,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/confluence/i);
  });

  it("rejects when projected net falls below hurdle rate", () => {
    // Force hurdle failure by spiking hurdle to an impossible level.
    const snapshot = makeSnapshot();
    const result = evaluateMintPremiumOpportunity(
      snapshot,
      makeConfig({ hurdleRate: 0.5 }),
    );

    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/hurdle/i);
  });

  it("downgrades offset to +0.5c and warns when trade_count_1h < 3", () => {
    // Aggressive-volume market but per-leg activity very low.
    const snapshot = makeSnapshot({
      volume_24h: 75_000,
      trade_count_1h: 2,
      bid_ask_spread: 0.008,
    });
    const result = evaluateMintPremiumOpportunity(snapshot, makeConfig());

    expect(result.viable).toBe(true);
    expect(result.offsetC).toBeCloseTo(0.005, 6);
    expect(result.reason).toMatch(/low[_ ]?activity/i);
  });
});
