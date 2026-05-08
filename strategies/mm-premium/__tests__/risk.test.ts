import { describe, it, expect } from "vitest";
import { createRiskChecker } from "../risk.js";
import {
  DEFAULT_MM_PREMIUM_CONFIG,
  type MintPremiumConfig,
} from "../config.js";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio, Position } from "../../../types/RiskInterface.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

function makeConfig(
  overrides?: Partial<MintPremiumConfig>,
): MintPremiumConfig {
  return { ...DEFAULT_MM_PREMIUM_CONFIG, ...overrides };
}

function makeSignal(
  overrides?: Partial<TradeSignal>,
): TradeSignal {
  return {
    automation_id: "mm-premium-v1",
    timestamp: new Date("2026-04-20T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will the Lakers win?",
    },
    direction: "buy_yes",
    size: 1_000,
    confidence: 0.9,
    urgency: "opportunistic",
    metadata: {
      offsetC: 0.0075,
      projectedNet: 13.575,
      cycleCapital: 1_000,
      netReturn: 0.013575,
      timeToCloseMs: 7 * 24 * HOUR_MS,
      trade_count_1h: 15,
    },
    ...overrides,
  };
}

function makePortfolio(
  overrides?: Partial<Portfolio>,
): Portfolio {
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
    entry_price: 0.5,
    opened_at: new Date("2026-04-20T00:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Risk checks
// ---------------------------------------------------------------------------

describe("createRiskChecker (mm-premium)", () => {
  describe("preTradeCheck", () => {
    it("approves a cycle within all limits", () => {
      const risk = createRiskChecker(makeConfig());
      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());

      expect(decision.approved).toBe(true);
      expect(decision.rejection_reason).toBeUndefined();
    });

    it("rejects when timeToClose < 24h", () => {
      const risk = createRiskChecker(makeConfig());
      const signal = makeSignal({
        metadata: {
          offsetC: 0.0075,
          projectedNet: 13.575,
          cycleCapital: 1_000,
          netReturn: 0.013575,
          timeToCloseMs: 12 * HOUR_MS,
          trade_count_1h: 15,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/close|cutoff|ttc/i);
    });

    it("rejects when projected net / capital falls below hurdle", () => {
      const risk = createRiskChecker(makeConfig());
      const signal = makeSignal({
        metadata: {
          offsetC: 0.005,
          projectedNet: 5,
          cycleCapital: 1_000,
          netReturn: 0.005,
          timeToCloseMs: 7 * 24 * HOUR_MS,
          trade_count_1h: 15,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/hurdle/i);
    });

    it("clamps signal size to remaining 25% bankroll exposure headroom", () => {
      // bankroll $10,000 × 25% = $2,500 exposure limit.
      // Two open $1,000 cycles already deployed (= $2,000).
      // New $1,000 cycle would push exposure to $3,000; clamped to $500.
      const risk = createRiskChecker(makeConfig());
      const portfolio = makePortfolio({
        positions: [
          makePosition(1_000, "cond-A"),
          makePosition(1_000, "cond-B"),
        ],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(500);
    });

    it("clamps signal size to live wallet capital when bankroll is stale", () => {
      // Persisted bankroll = $10k, but the wallet only holds $9.83.
      // Signal of $1,000 must clamp to live capital.
      const risk = createRiskChecker(makeConfig({ bankroll: 10_000 }));
      const portfolio = makePortfolio({ total_value: 9.83, positions: [] });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(9.83);
    });

    it("rejects when no headroom remains under any cap", () => {
      const risk = createRiskChecker(makeConfig());
      const portfolio = makePortfolio({ total_value: 0 });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/headroom|capital/i);
    });

    it("approves at full size when active exposure is under cap", () => {
      // $1,000 deployed + $1,000 new = $2,000 <= $2,500 limit.
      const risk = createRiskChecker(makeConfig());
      const portfolio = makePortfolio({
        positions: [makePosition(1_000, "cond-A")],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBeUndefined();
    });
  });

  describe("onCircuitBreaker", () => {
    it("halts further approvals once tripped", () => {
      const risk = createRiskChecker(makeConfig());
      risk.onCircuitBreaker("manual halt");

      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/circuit.?breaker|halt/i);
    });
  });
});
