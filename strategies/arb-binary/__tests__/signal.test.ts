import { describe, it, expect } from "vitest";
import { detectSignals } from "../signal.js";
import type { MarketData, ArbBinaryConfig } from "../signal.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeMarket(
  overrides?: Partial<MarketData>,
): MarketData {
  return {
    conditionId: "cond-001",
    question: "Will the Lakers win?",
    category: "NBA",
    yesAsk: 0.40,
    noAsk: 0.40,
    yesTokenId: "tok-yes-001",
    noTokenId: "tok-no-001",
    estimatedSlippage: 0.001,
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<ArbBinaryConfig>,
): ArbBinaryConfig {
  return {
    category: "NBA",
    feeRate: 0.02,
    gasCost: 0.02,
    hurdleRate: 0.015,
    slippageAbort: 0.003,
    bankroll: 10_000,
    kellyFraction: 0.25,
    maxExposure: 0.08,
    signalTtlMs: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Edge detection
// ---------------------------------------------------------------------------

describe("detectSignals", () => {
  it("returns buy_yes + buy_no when edge found (sum < $1.00)", () => {
    // YES=0.40 + NO=0.40 = 0.80 < 1.00
    // netReturn = (0.20 - 0.036) / 0.80 = 20.5% > 1.5% hurdle
    const market = makeMarket({ yesAsk: 0.40, noAsk: 0.40 });
    const signals = detectSignals([market], makeConfig());

    expect(signals).toHaveLength(2);

    const yes = signals.find((s) => s.direction === "buy_yes");
    const no = signals.find((s) => s.direction === "buy_no");

    expect(yes).toBeDefined();
    expect(no).toBeDefined();
    expect(yes!.market.market_id).toBe("cond-001");
    expect(yes!.market.platform).toBe("polymarket");
    expect(yes!.automation_id).toContain("arb-binary");
    expect(yes!.urgency).toBe("immediate");
    expect(yes!.size).toBeGreaterThan(0);
    expect(yes!.confidence).toBeGreaterThan(0);
    expect(yes!.confidence).toBeLessThanOrEqual(1);
    expect(no!.market.market_id).toBe("cond-001");
    expect(no!.size).toBeGreaterThan(0);
  });

  it("returns no signals when sum >= $1.00 (no edge)", () => {
    // YES=0.55 + NO=0.50 = 1.05 > 1.00
    const market = makeMarket({ yesAsk: 0.55, noAsk: 0.50 });
    const signals = detectSignals([market], makeConfig());

    expect(signals).toHaveLength(0);
  });

  it("returns no signals when sum equals exactly $1.00", () => {
    const market = makeMarket({ yesAsk: 0.50, noAsk: 0.50 });
    const signals = detectSignals([market], makeConfig());

    expect(signals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Fee deduction
  // -------------------------------------------------------------------------

  it("deducts fees and reports breakdown in metadata", () => {
    // cost = 0.80
    // grossEdge = 1.00 - 0.80 = 0.20
    // totalFees = 0.80 * 0.02 + 0.02 = 0.036
    // netEdge = 0.20 - 0.036 = 0.164
    // netReturn = 0.164 / 0.80 = 0.205
    const market = makeMarket({ yesAsk: 0.40, noAsk: 0.40 });
    const signals = detectSignals([market], makeConfig());

    expect(signals.length).toBeGreaterThan(0);
    const signal = signals[0]!;

    expect(signal.metadata["grossEdge"]).toBeCloseTo(0.20, 4);
    expect(signal.metadata["totalFees"]).toBeCloseTo(0.036, 4);
    expect(signal.metadata["netEdge"]).toBeCloseTo(0.164, 4);
    expect(signal.metadata["netReturn"]).toBeCloseTo(0.205, 3);
  });

  // -------------------------------------------------------------------------
  // Token IDs propagated for live execution
  // -------------------------------------------------------------------------

  it("propagates yes/no CLOB token IDs through signal metadata", () => {
    const market = makeMarket({ yesAsk: 0.40, noAsk: 0.40 });
    const signals = detectSignals([market], makeConfig());

    expect(signals.length).toBe(2);
    for (const signal of signals) {
      expect(signal.metadata["yesTokenId"]).toBe(market.yesTokenId);
      expect(signal.metadata["noTokenId"]).toBe(market.noTokenId);
    }
  });

  // -------------------------------------------------------------------------
  // Hurdle rate
  // -------------------------------------------------------------------------

  it("filters market below hurdle rate after fees", () => {
    // cost = 0.95, grossEdge = 0.05
    // fees = 0.95 * 0.02 + 0.02 = 0.039
    // netEdge = 0.011, netReturn = 1.16% < 1.5% hurdle
    const market = makeMarket({ yesAsk: 0.45, noAsk: 0.50 });
    const signals = detectSignals([market], makeConfig());

    expect(signals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Slippage abort
  // -------------------------------------------------------------------------

  it("aborts signal when slippage exceeds threshold", () => {
    // Edge exists (sum=0.80, 20.5% net return) but
    // slippage 0.5% > 0.3% abort threshold
    const market = makeMarket({
      yesAsk: 0.40,
      noAsk: 0.40,
      estimatedSlippage: 0.005,
    });
    const signals = detectSignals([market], makeConfig());

    expect(signals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Multiple markets with mixed edges
  // -------------------------------------------------------------------------

  it("returns signals only for qualifying markets", () => {
    const markets = [
      makeMarket({
        conditionId: "cond-A",
        question: "Market A",
        yesAsk: 0.40,
        noAsk: 0.40,
      }),
      makeMarket({
        conditionId: "cond-B",
        question: "Market B",
        yesAsk: 0.55,
        noAsk: 0.50,
      }),
      makeMarket({
        conditionId: "cond-C",
        question: "Market C",
        yesAsk: 0.35,
        noAsk: 0.35,
      }),
    ];
    const signals = detectSignals(markets, makeConfig());

    // 2 signals per qualifying market x 2 qualifying = 4
    expect(signals).toHaveLength(4);

    const ids = [...new Set(signals.map((s) => s.market.market_id))];
    expect(ids).toContain("cond-A");
    expect(ids).toContain("cond-C");
    expect(ids).not.toContain("cond-B");
  });

  // -------------------------------------------------------------------------
  // Empty input
  // -------------------------------------------------------------------------

  it("returns empty array for empty market list", () => {
    const signals = detectSignals([], makeConfig());

    expect(signals).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Category filtering
  // -------------------------------------------------------------------------

  it("filters out markets not matching config category", () => {
    const markets = [
      makeMarket({
        conditionId: "nba-001",
        category: "NBA",
        yesAsk: 0.40,
        noAsk: 0.40,
      }),
      makeMarket({
        conditionId: "crypto-001",
        category: "crypto",
        yesAsk: 0.30,
        noAsk: 0.30,
      }),
    ];
    const signals = detectSignals(markets, makeConfig());

    // Only NBA market qualifies
    expect(signals).toHaveLength(2);
    const ids = signals.map((s) => s.market.market_id);
    expect(ids).toContain("nba-001");
    expect(ids).not.toContain("crypto-001");
  });
});
