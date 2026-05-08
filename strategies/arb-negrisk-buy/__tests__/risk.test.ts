import { describe, it, expect } from "vitest";
import { createRiskChecker } from "../risk.js";
import type { RiskConfig } from "../risk.js";
import type { NegRiskLeg, NegRiskMarket, NegRiskOpportunity } from "../signal.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeRiskConfig(
  overrides?: Partial<RiskConfig>,
): RiskConfig {
  return {
    bankroll: 10_000,
    kellyFraction: 0.15,
    maxExposure: 0.05,
    minLegLiquidity: 300,
    maxLegPriceWithLowLiq: 0.30,
    lowLiqThreshold: 100,
    maxConsecutiveLosses: 3,
    ...overrides,
  };
}

function makeLeg(
  overrides?: Partial<NegRiskLeg>,
): NegRiskLeg {
  return {
    tokenId: "tok-001",
    outcome: "Team A",
    yesBid: 0.20,
    liquidity: 1_000,
    ...overrides,
  };
}

function makeMarket(
  overrides?: Partial<NegRiskMarket>,
): NegRiskMarket {
  return {
    conditionId: "negrisk-001",
    question: "Who wins the NBA championship?",
    category: "NBA Champion",
    isNegRisk: true,
    legs: [
      makeLeg({ tokenId: "tok-A", outcome: "A", yesBid: 0.20 }),
      makeLeg({ tokenId: "tok-B", outcome: "B", yesBid: 0.20 }),
      makeLeg({ tokenId: "tok-C", outcome: "C", yesBid: 0.20 }),
    ],
    ...overrides,
  };
}

function makeOpportunity(
  overrides?: Partial<NegRiskOpportunity>,
): NegRiskOpportunity {
  const market = overrides?.market ?? makeMarket();
  const legCount = market.legs.length;
  const sum = market.legs.reduce((acc, l) => acc + l.yesBid, 0);
  const grossEdge = 1.0 - sum;
  const totalFees = sum * 0.02;
  const gasCost = 0.05 * legCount;
  const netEdge = grossEdge - totalFees - gasCost;
  return {
    market,
    sum,
    grossEdge,
    totalFees,
    gasCost,
    netEdge,
    legCount,
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
    it("approves an opportunity within all limits", () => {
      const risk = createRiskChecker(makeRiskConfig());
      const opp = makeOpportunity();
      const portfolio = makePortfolio();

      const decision = risk.preTradeCheck(opp, portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.rejection_reason).toBeUndefined();
    });

    it("rejects when the weakest leg is below minLegLiquidity (bottleneck)", () => {
      // minLegLiquidity = 300; one leg at 250 < 300 → reject
      const market = makeMarket({
        legs: [
          makeLeg({ tokenId: "A", yesBid: 0.20, liquidity: 1_000 }),
          makeLeg({ tokenId: "B", yesBid: 0.20, liquidity: 250 }),
          makeLeg({ tokenId: "C", yesBid: 0.20, liquidity: 1_000 }),
        ],
      });
      const risk = createRiskChecker(makeRiskConfig());
      const decision = risk.preTradeCheck(
        makeOpportunity({ market }),
        makePortfolio(),
      );

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toBeDefined();
      expect(decision.rejection_reason).toMatch(/liquidity|bottleneck/i);
    });

    it("rejects when any leg has price > 0.30 with liquidity < lowLiqThreshold", () => {
      // price 0.35 > 0.30 AND liquidity 80 < 100 → reject
      const market = makeMarket({
        legs: [
          makeLeg({ tokenId: "A", yesBid: 0.20, liquidity: 1_000 }),
          makeLeg({ tokenId: "B", yesBid: 0.35, liquidity: 80 }),
          makeLeg({ tokenId: "C", yesBid: 0.20, liquidity: 1_000 }),
        ],
      });
      const risk = createRiskChecker(makeRiskConfig());
      const decision = risk.preTradeCheck(
        makeOpportunity({ market }),
        makePortfolio(),
      );

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toBeDefined();
      expect(decision.rejection_reason).toMatch(/price|thin|cap/i);
    });

    it("approves a leg priced > 0.30 when its liquidity meets lowLiqThreshold", () => {
      // price 0.35 but liquidity 500 >= 100 → low-liq cap does NOT trigger
      const market = makeMarket({
        legs: [
          makeLeg({ tokenId: "A", yesBid: 0.15, liquidity: 1_000 }),
          makeLeg({ tokenId: "B", yesBid: 0.35, liquidity: 500 }),
          makeLeg({ tokenId: "C", yesBid: 0.15, liquidity: 1_000 }),
        ],
      });
      const risk = createRiskChecker(makeRiskConfig());
      const decision = risk.preTradeCheck(
        makeOpportunity({ market }),
        makePortfolio(),
      );

      expect(decision.approved).toBe(true);
    });

    it("caps total bundle exposure at maxExposure × bankroll (5% total)", () => {
      // maxExposure = 0.05 × 10_000 = $500 total across all legs
      const risk = createRiskChecker(makeRiskConfig());
      const opp = makeOpportunity();
      const decision = risk.preTradeCheck(opp, makePortfolio());

      expect(decision.approved).toBe(true);
      expect(decision.total_size).toBeDefined();
      expect(decision.total_size!).toBeLessThanOrEqual(500 + 1e-6);
    });

    it("sizes each leg from the bottleneck liquidity (weakest leg caps the bundle)", () => {
      // Weakest leg liquidity 400 should cap per-leg size at <= 400.
      const market = makeMarket({
        legs: [
          makeLeg({ tokenId: "A", yesBid: 0.20, liquidity: 2_000 }),
          makeLeg({ tokenId: "B", yesBid: 0.20, liquidity: 400 }),
          makeLeg({ tokenId: "C", yesBid: 0.20, liquidity: 2_000 }),
        ],
      });
      const risk = createRiskChecker(makeRiskConfig());
      const decision = risk.preTradeCheck(
        makeOpportunity({ market }),
        makePortfolio(),
      );

      expect(decision.approved).toBe(true);
      expect(decision.per_leg_size).toBeDefined();
      expect(decision.per_leg_size!).toBeLessThanOrEqual(400 + 1e-6);
    });

    it("clamps total bundle to live wallet capital when bankroll is stale", () => {
      // Persisted bankroll = $10k, but the wallet only holds $9.83.
      // Bundle exposure cap = 5% × $10k = $500; Kelly bundle would be
      // sized at the smaller of those, but live capital ($9.83) binds
      // tighter still and clamps the total bundle.
      const risk = createRiskChecker(makeRiskConfig({ bankroll: 10_000 }));
      const portfolio = makePortfolio({ total_value: 9.83, positions: [] });
      const decision = risk.preTradeCheck(makeOpportunity(), portfolio);

      expect(decision.approved).toBe(true);
      expect(decision.total_size).toBeCloseTo(9.83, 2);
    });

    it("rejects when no headroom remains under any cap", () => {
      const risk = createRiskChecker(makeRiskConfig());
      const portfolio = makePortfolio({ total_value: 0 });
      const decision = risk.preTradeCheck(makeOpportunity(), portfolio);

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/headroom|capital/i);
    });

    it("rejects when Kelly bundle size has no edge (netEdge ≤ 0)", () => {
      const risk = createRiskChecker(makeRiskConfig());
      const market = makeMarket({
        // Sum of bids ≥ 1.0 → grossEdge ≤ 0 → netEdge negative.
        legs: [
          makeLeg({ tokenId: "A", yesBid: 0.40, liquidity: 1_000 }),
          makeLeg({ tokenId: "B", yesBid: 0.35, liquidity: 1_000 }),
          makeLeg({ tokenId: "C", yesBid: 0.30, liquidity: 1_000 }),
        ],
      });
      const decision = risk.preTradeCheck(
        makeOpportunity({ market }),
        makePortfolio(),
      );

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toMatch(/kelly|edge/i);
    });

    it("triggers circuit breaker after consecutive losses", () => {
      const risk = createRiskChecker(
        makeRiskConfig({ maxConsecutiveLosses: 3 }),
      );

      risk.recordOutcome(false);
      risk.recordOutcome(false);
      risk.recordOutcome(false);

      const decision = risk.preTradeCheck(makeOpportunity(), makePortfolio());

      expect(decision.approved).toBe(false);
      expect(decision.rejection_reason).toBeDefined();
      expect(decision.rejection_reason).toMatch(/circuit.?breaker/i);
    });
  });
});
