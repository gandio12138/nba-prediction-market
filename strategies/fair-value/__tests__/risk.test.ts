import { describe, it, expect } from "vitest";
import { createRiskChecker } from "../risk.js";
import {
  DEFAULT_FAIR_VALUE_CONFIG,
  type FairValueConfig,
} from "../config.js";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio, Position } from "../../../types/RiskInterface.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Fixed "now" — all signal timestamps are relative to this.
const NOW = new Date("2026-04-20T12:00:00Z");

function makeConfig(overrides?: Partial<FairValueConfig>): FairValueConfig {
  return { ...DEFAULT_FAIR_VALUE_CONFIG, ...overrides };
}

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    automation_id: "fair-value-v1",
    timestamp: NOW,
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will X happen?",
    },
    direction: "buy_yes",
    // 10% of $10k bankroll — exactly at per-position cap.
    size: 1_000,
    confidence: 0.8,
    urgency: "normal",
    metadata: {
      fairValue: 0.55,
      marketPrice: 0.40,
      divergence: 0.15,
      tier: "full",
      sizingMultiplier: 1.0,
      sources: ["a", "b"],
      confidence: 0.8,
      timeToCloseMs: 14 * DAY_MS,
      volume24h: 20_000,
      openInterest: 10_000,
      limitOnly: true,
    },
    ...overrides,
  };
}

function makePortfolio(overrides?: Partial<Portfolio>): Portfolio {
  return {
    total_value: 10_000,
    positions: [],
    daily_pnl: 0,
    ...overrides,
  };
}

function makePosition(size: number, marketId: string): Position {
  return {
    market_id: marketId,
    direction: "buy_yes",
    size,
    entry_price: 0.40,
    opened_at: new Date("2026-04-20T00:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// preTradeCheck
// ---------------------------------------------------------------------------

describe("createRiskChecker (fair-value)", () => {
  describe("preTradeCheck", () => {
    it("approves a signal within all limits", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
      expect(decision.approved).toBe(true);
      expect(decision.rejection_reason).toBeUndefined();
    });

    it("clamps requested size to the 10% per-position exposure cap", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      // $1,500 = 15% of $10k — above 10% per-position cap, clamped to $1,000.
      const decision = risk.preTradeCheck(
        makeSignal({ size: 1_500 }),
        makePortfolio(),
      );
      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(1_000);
    });

    it("clamps signal size to live wallet capital when bankroll is stale", () => {
      // Persisted bankroll = $10k, but the wallet only holds $9.83.
      const risk = createRiskChecker(makeConfig({ bankroll: 10_000 }), () => NOW);
      const decision = risk.preTradeCheck(
        makeSignal({ size: 1_000 }),
        makePortfolio({ total_value: 9.83, positions: [] }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(9.83);
    });

    it("rejects a 6th concurrent position (maxConcurrent = 5)", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const portfolio = makePortfolio({
        positions: [
          makePosition(1_000, "cond-A"),
          makePosition(1_000, "cond-B"),
          makePosition(1_000, "cond-C"),
          makePosition(1_000, "cond-D"),
          makePosition(1_000, "cond-E"),
        ],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(
        /concurrent|positions|count|max/i,
      );
    });

    it("approves when 4 positions are open (headroom for 1 more)", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const portfolio = makePortfolio({
        positions: [
          makePosition(1_000, "cond-A"),
          makePosition(1_000, "cond-B"),
          makePosition(1_000, "cond-C"),
          makePosition(1_000, "cond-D"),
        ],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);
      expect(decision.approved).toBe(true);
    });

    it("enforces the 50% portfolio cap (maxConcurrent × maxExposurePerPosition)", () => {
      // 5 × 10% = 50% aggregate ceiling. With 4 × $1,000 open = 40%,
      // a new $1,000 would total $5,000 = 50% — still allowed at cap.
      // With 5 × $1,000 open = 50%, a new position would breach.
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const portfolio = makePortfolio({
        positions: [
          makePosition(1_000, "cond-A"),
          makePosition(1_000, "cond-B"),
          makePosition(1_000, "cond-C"),
          makePosition(1_000, "cond-D"),
          makePosition(1_000, "cond-E"),
        ],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(
        /exposure|portfolio|concurrent|cap|max/i,
      );
    });

    it("rejects when timeToClose < 7d hard floor", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const signal = makeSignal({
        metadata: {
          fairValue: 0.55,
          marketPrice: 0.40,
          divergence: 0.15,
          tier: "full",
          sizingMultiplier: 1.0,
          sources: ["a", "b"],
          confidence: 0.8,
          timeToCloseMs: 3 * DAY_MS,
          volume24h: 20_000,
          openInterest: 10_000,
          limitOnly: true,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/close|time|runway|ttc/i);
    });

    it("rejects when liquidity (volume_24h) is below the $5k floor", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const signal = makeSignal({
        metadata: {
          fairValue: 0.55,
          marketPrice: 0.40,
          divergence: 0.15,
          tier: "full",
          sizingMultiplier: 1.0,
          sources: ["a", "b"],
          confidence: 0.8,
          timeToCloseMs: 14 * DAY_MS,
          volume24h: 1_000,
          openInterest: 10_000,
          limitOnly: true,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/liquid|volume/i);
    });

    it("rejects when openInterest is below the $3k floor", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const signal = makeSignal({
        metadata: {
          fairValue: 0.55,
          marketPrice: 0.40,
          divergence: 0.15,
          tier: "full",
          sizingMultiplier: 1.0,
          sources: ["a", "b"],
          confidence: 0.8,
          timeToCloseMs: 14 * DAY_MS,
          volume24h: 20_000,
          openInterest: 500,
          limitOnly: true,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/liquid|open.?interest|oi/i);
    });

    it("rejects signals older than the 24h TTL", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      // Signal timestamp 25h before NOW → stale.
      const staleAt = new Date(NOW.getTime() - 25 * HOUR_MS);
      const decision = risk.preTradeCheck(
        makeSignal({ timestamp: staleAt }),
        makePortfolio(),
      );
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/ttl|stale|expired|age/i);
    });

    it("accepts a signal emitted 23h ago (within TTL)", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const fresh = new Date(NOW.getTime() - 23 * HOUR_MS);
      const decision = risk.preTradeCheck(
        makeSignal({ timestamp: fresh }),
        makePortfolio(),
      );
      expect(decision.approved).toBe(true);
    });

    it("requires limit-only intent in signal metadata", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const signal = makeSignal({
        metadata: {
          fairValue: 0.55,
          marketPrice: 0.40,
          divergence: 0.15,
          tier: "full",
          sizingMultiplier: 1.0,
          sources: ["a", "b"],
          confidence: 0.8,
          timeToCloseMs: 14 * DAY_MS,
          volume24h: 20_000,
          openInterest: 10_000,
          limitOnly: false,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/limit|market.?order|intent/i);
    });
  });

  describe("onCircuitBreaker", () => {
    it("halts further approvals once tripped", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      risk.onCircuitBreaker("daily loss limit reached");
      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/circuit.?breaker|halt/i);
    });
  });

  describe("getExposure", () => {
    it("returns zeros when no trades have been recorded", () => {
      const risk = createRiskChecker(makeConfig(), () => NOW);
      const exposure = risk.getExposure();
      expect(exposure.total_capital_deployed).toBe(0);
      expect(exposure.position_count).toBe(0);
      expect(exposure.largest_position).toBe(0);
      expect(exposure.markets).toEqual([]);
    });
  });
});
