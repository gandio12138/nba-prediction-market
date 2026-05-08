import { describe, it, expect } from "vitest";
import { createRiskChecker } from "../risk.js";
import {
  DEFAULT_TRADE_MOMENTUM_CONFIG,
  type TradeMomentumConfig,
} from "../config.js";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio, Position } from "../../../types/RiskInterface.js";

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

function makeSignal(
  overrides?: Partial<TradeSignal>,
): TradeSignal {
  return {
    automation_id: "trade-momentum-v1",
    timestamp: new Date("2026-04-20T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will X happen?",
    },
    direction: "buy_yes",
    size: 1_000, // 10% of $10k bankroll — exactly at per-position cap.
    confidence: 0.7,
    urgency: "normal",
    metadata: {
      entryPrice: 0.25,
      exitTargetPrice: 0.50,
      projectedNet: 250,
      netReturn: 1.0,
      timeToCloseMs: 14 * DAY_MS,
      confluenceCount: 3,
      topWalletShare: 0.2,
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
    entry_price: 0.25,
    opened_at: new Date("2026-04-20T00:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Risk checks
// ---------------------------------------------------------------------------

describe("createRiskChecker (trade-momentum)", () => {
  describe("preTradeCheck", () => {
    it("approves a signal within all limits", () => {
      const risk = createRiskChecker(makeConfig());
      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
      expect(decision.approved).toBe(true);
      expect(decision.rejection_reason).toBeUndefined();
    });

    it("rejects when timeToClose < 24h hard floor", () => {
      const risk = createRiskChecker(makeConfig());
      const signal = makeSignal({
        metadata: {
          entryPrice: 0.25,
          exitTargetPrice: 0.50,
          projectedNet: 250,
          netReturn: 1.0,
          timeToCloseMs: 12 * HOUR_MS,
          confluenceCount: 3,
          topWalletShare: 0.2,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/close|cutoff|ttc|runway|time/i);
    });

    it("clamps requested size to the 10% per-position exposure cap", () => {
      const risk = createRiskChecker(makeConfig());
      // $1,500 = 15% of $10k — above 10% cap, clamped to $1,000.
      const decision = risk.preTradeCheck(
        makeSignal({ size: 1_500 }),
        makePortfolio(),
      );
      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(1_000);
    });

    it("clamps signal size to live portfolio capital when bankroll is stale", () => {
      // Persisted bankroll = $10k, but the wallet only holds $9.83.
      // Signal sized at the 10% per-position cap = $1,000 must clamp to
      // the live total_value so the executor never submits an order the
      // wallet cannot cover. This is the live-test-4 regression.
      const risk = createRiskChecker(makeConfig({ bankroll: 10_000 }));
      const decision = risk.preTradeCheck(
        makeSignal({ size: 1_000 }),
        makePortfolio({ total_value: 9.83, positions: [] }),
      );
      expect(decision.approved).toBe(true);
      expect(decision.modified_size).toBe(9.83);
    });

    it("rejects when no headroom remains under any cap", () => {
      // Bankroll $10k, no open positions, but live total_value is $0
      // — the wallet has nothing to spend, so the signal is rejected.
      const risk = createRiskChecker(makeConfig());
      const decision = risk.preTradeCheck(
        makeSignal({ size: 1_000 }),
        makePortfolio({ total_value: 0 }),
      );
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/headroom|capital/i);
    });

    it("rejects a 4th concurrent position (maxConcurrent = 3)", () => {
      const risk = createRiskChecker(makeConfig());
      const portfolio = makePortfolio({
        positions: [
          makePosition(1_000, "cond-A"),
          makePosition(1_000, "cond-B"),
          makePosition(1_000, "cond-C"),
        ],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/concurrent|count|positions|max/i);
    });

    it("rejects when total exposure would exceed the 30% aggregate cap", () => {
      // Two $1,000 open = $2,000 (20%). New $1,000 → $3,000 = 30% exact cap.
      // Push with a $500 larger request would breach: but 1,500 > per-pos cap.
      // Instead, set bankroll lower so the cap binds before per-position cap.
      const risk = createRiskChecker(makeConfig({ bankroll: 6_000 }));
      // On a $6k bankroll, 10% per-position = $600, 30% total = $1,800.
      const portfolio = makePortfolio({
        total_value: 6_000,
        positions: [
          makePosition(600, "cond-A"),
          makePosition(600, "cond-B"),
          makePosition(600, "cond-C"),
        ],
      });
      const decision = risk.preTradeCheck(
        makeSignal({ size: 600 }),
        portfolio,
      );
      expect(decision.approved).toBe(false);
      // Either count cap or exposure cap — both are valid rejection reasons.
      expect(decision.rejection_reason).toMatch(
        /exposure|concurrent|positions|count|max/i,
      );
    });

    it("approves when one position is already open and cap has headroom", () => {
      const risk = createRiskChecker(makeConfig());
      const portfolio = makePortfolio({
        positions: [makePosition(1_000, "cond-A")],
      });
      const decision = risk.preTradeCheck(makeSignal(), portfolio);
      expect(decision.approved).toBe(true);
    });

    it("rejects when the signal's topWalletShare exceeds 0.80", () => {
      const risk = createRiskChecker(makeConfig());
      const signal = makeSignal({
        metadata: {
          entryPrice: 0.25,
          exitTargetPrice: 0.50,
          projectedNet: 250,
          netReturn: 1.0,
          timeToCloseMs: 14 * DAY_MS,
          confluenceCount: 3,
          topWalletShare: 0.85,
        },
      });
      const decision = risk.preTradeCheck(signal, makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/wallet|concentr|manipul/i);
    });
  });

  describe("onCircuitBreaker", () => {
    it("halts further approvals once tripped", () => {
      const risk = createRiskChecker(makeConfig());
      risk.onCircuitBreaker("daily loss limit reached");
      const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/circuit.?breaker|halt/i);
    });
  });
});
