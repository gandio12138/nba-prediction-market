import { describe, it, expect } from "vitest";
import { createRiskChecker } from "../risk.js";
import type { RiskConfig } from "../risk.js";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeRiskConfig(
  overrides?: Partial<RiskConfig>,
): RiskConfig {
  return {
    bankroll: 10_000,
    kellyFraction: 0.25,
    maxExposure: 0.08,
    maxConsecutiveLosses: 3,
    ...overrides,
  };
}

function makeSignal(
  overrides?: Partial<TradeSignal>,
): TradeSignal {
  return {
    automation_id: "arb-binary-v1",
    timestamp: new Date("2026-04-15T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will the Lakers win?",
    },
    direction: "buy_yes",
    size: 200,
    confidence: 0.95,
    urgency: "immediate",
    metadata: {
      grossEdge: 0.20,
      totalFees: 0.036,
      netEdge: 0.164,
      netReturn: 0.205,
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

// ---------------------------------------------------------------------------
// Risk checks
// ---------------------------------------------------------------------------

describe("createRiskChecker", () => {
  describe("preTradeCheck", () => {
    it("approves trade within all limits", () => {
      // size=$200 < maxExposure=$800
      // Kelly = 10000 × 0.25 × 0.205 = $512.50 > $200 → no modification
      const risk = createRiskChecker(makeRiskConfig());
      const signal = makeSignal({ size: 200 });
      const portfolio = makePortfolio();

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.rejection_reason).toBeUndefined();
      expect(decision.modified_size).toBeUndefined();
    });

    it("clamps trade to 8% bankroll exposure cap", () => {
      // maxExposure = 0.08 × $10,000 = $800
      // signal size $900 > $800 → clamped to $800.
      const risk = createRiskChecker(makeRiskConfig());
      const signal = makeSignal({
        size: 900,
        metadata: {
          grossEdge: 0.30,
          totalFees: 0.04,
          netEdge: 0.26,
          netReturn: 0.50,
        },
      });
      const portfolio = makePortfolio();

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(800);
    });

    it("clamps signal size to live wallet capital when bankroll is stale", () => {
      // Persisted bankroll = $10k, but the wallet only holds $9.83.
      const risk = createRiskChecker(makeRiskConfig({ bankroll: 10_000 }));
      const signal = makeSignal({ size: 500 });
      const portfolio = makePortfolio({ total_value: 9.83, positions: [] });

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(9.83);
    });

    it("rejects when no headroom remains under any cap", () => {
      const risk = createRiskChecker(makeRiskConfig());
      const signal = makeSignal({ size: 200 });
      const portfolio = makePortfolio({ total_value: 0 });

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/headroom|capital/i);
    });

    it("rejects when Kelly sizing reduces to zero", () => {
      // netReturn = 0 → Kelly = 10000 × 0.25 × 0 = $0 → rejected
      const risk = createRiskChecker(makeRiskConfig());
      const signal = makeSignal({
        size: 100,
        metadata: {
          grossEdge: 0.001,
          totalFees: 0.001,
          netEdge: 0,
          netReturn: 0,
        },
      });
      const portfolio = makePortfolio();

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toBeDefined();
      expect(decision.rejection_reason).toMatch(/kelly/i);
    });

    it("modifies size via Kelly fractional sizing", () => {
      // netReturn = 0.10 → Kelly = 10000 × 0.25 × 0.10 = $250
      // signal requests $500 → reduced to $250
      const risk = createRiskChecker(makeRiskConfig());
      const signal = makeSignal({
        size: 500,
        metadata: {
          grossEdge: 0.10,
          totalFees: 0.02,
          netEdge: 0.08,
          netReturn: 0.10,
        },
      });
      const portfolio = makePortfolio();

      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBeDefined();
      expect(decision.modified_size).toBeCloseTo(250, 0);
      expect(decision.modified_size!).toBeLessThan(500);
    });

    it("triggers circuit breaker after consecutive losses", () => {
      const risk = createRiskChecker(
        makeRiskConfig({ maxConsecutiveLosses: 3 }),
      );

      // Record 3 consecutive losses to trip the breaker
      risk.recordOutcome(false);
      risk.recordOutcome(false);
      risk.recordOutcome(false);

      const signal = makeSignal({ size: 200 });
      const portfolio = makePortfolio();
      const decision = risk.preTradeCheck(signal, portfolio);

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toBeDefined();
      expect(decision.rejection_reason).toMatch(/circuit.?breaker/i);
    });
  });
});
