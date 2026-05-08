import { describe, it, expect } from "vitest";
import { evaluateNegRiskOpportunity } from "../signal.js";
import type { NegRiskLeg, NegRiskMarket } from "../signal.js";
import type { NegRiskBuyConfig } from "../config.js";
import { DEFAULT_NEGRISK_BUY_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

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
      makeLeg({ tokenId: "tok-A", outcome: "Team A", yesBid: 0.20 }),
      makeLeg({ tokenId: "tok-B", outcome: "Team B", yesBid: 0.20 }),
      makeLeg({ tokenId: "tok-C", outcome: "Team C", yesBid: 0.20 }),
      makeLeg({ tokenId: "tok-D", outcome: "Team D", yesBid: 0.20 }),
    ],
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<NegRiskBuyConfig>,
): NegRiskBuyConfig {
  return { ...DEFAULT_NEGRISK_BUY_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Edge detection
// ---------------------------------------------------------------------------

describe("evaluateNegRiskOpportunity", () => {
  it("returns an opportunity when sum(YES_bid) < threshold with net edge > hurdle", () => {
    // sum = 0.20 * 4 = 0.80
    // grossEdge = 1.00 - 0.80 = 0.20
    // fees = 0.02 * 0.80 = 0.016
    // gas = 0.05 * 4 = 0.20
    // netEdge = 0.20 - 0.016 - 0.20 = -0.016 → no signal
    // so use 5 legs at 0.15 each: sum = 0.75
    //   grossEdge = 0.25, fees = 0.015, gas = 0.25 → netEdge = -0.015 still negative
    // Use 3 legs at 0.20 each: sum = 0.60
    //   grossEdge = 0.40, fees = 0.012, gas = 0.15 → netEdge = 0.238 > 0.03 hurdle ✓
    const market = makeMarket({
      legs: [
        makeLeg({ tokenId: "tok-A", outcome: "A", yesBid: 0.20 }),
        makeLeg({ tokenId: "tok-B", outcome: "B", yesBid: 0.20 }),
        makeLeg({ tokenId: "tok-C", outcome: "C", yesBid: 0.20 }),
      ],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).not.toBeNull();
    expect(opp!.sum).toBeCloseTo(0.60, 4);
    expect(opp!.legCount).toBe(3);
    expect(opp!.grossEdge).toBeCloseTo(0.40, 4);
    expect(opp!.totalFees).toBeCloseTo(0.012, 4);
    expect(opp!.gasCost).toBeCloseTo(0.15, 4);
    expect(opp!.netEdge).toBeCloseTo(0.238, 3);
    expect(opp!.netEdge).toBeGreaterThanOrEqual(makeConfig().hurdleRate);
  });

  it("returns null when sum >= 1.00 (no edge)", () => {
    const market = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.35 }),
        makeLeg({ yesBid: 0.35 }),
        makeLeg({ yesBid: 0.35 }),
      ],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when sum equals exactly 1.00", () => {
    const market = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.25 }),
        makeLeg({ yesBid: 0.25 }),
        makeLeg({ yesBid: 0.25 }),
        makeLeg({ yesBid: 0.25 }),
      ],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when sum < 1.00 but net < hurdle (fees + gas eat the edge)", () => {
    // 4 legs at 0.24: sum = 0.96
    // grossEdge = 0.04, fees = 0.0192, gas = 0.20 → netEdge hugely negative
    const market = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.24 }),
        makeLeg({ yesBid: 0.24 }),
        makeLeg({ yesBid: 0.24 }),
        makeLeg({ yesBid: 0.24 }),
      ],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when sum is below 1.00 but above sumThreshold (confluence gate)", () => {
    // sumThreshold = 0.97; build sum in (0.97, 1.00) where hurdle would also fail.
    // 4 legs at 0.245: sum = 0.98 — fails sumThreshold gate.
    const market = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.245 }),
        makeLeg({ yesBid: 0.245 }),
        makeLeg({ yesBid: 0.245 }),
        makeLeg({ yesBid: 0.245 }),
      ],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when market category does not match config", () => {
    const market = makeMarket({ category: "crypto" });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when market is not flagged as NegRisk", () => {
    const market = makeMarket({ isNegRisk: false });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("returns null when fewer than 2 legs are present", () => {
    const market = makeMarket({
      legs: [makeLeg({ yesBid: 0.10 })],
    });
    const opp = evaluateNegRiskOpportunity(market, makeConfig());

    expect(opp).toBeNull();
  });

  it("scales gas cost by number of legs (per-leg gas)", () => {
    // 3 legs vs 4 legs at same per-leg yesBid: gas differs by 1x gasPerLeg.
    const legThree = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.20 }),
        makeLeg({ yesBid: 0.20 }),
        makeLeg({ yesBid: 0.20 }),
      ],
    });
    const legFour = makeMarket({
      legs: [
        makeLeg({ yesBid: 0.15 }),
        makeLeg({ yesBid: 0.15 }),
        makeLeg({ yesBid: 0.15 }),
        makeLeg({ yesBid: 0.15 }),
      ],
    });

    const config = makeConfig();
    const opp3 = evaluateNegRiskOpportunity(legThree, config);
    const opp4 = evaluateNegRiskOpportunity(legFour, config);

    expect(opp3).not.toBeNull();
    expect(opp4).not.toBeNull();
    expect(opp3!.gasCost).toBeCloseTo(config.gasPerLeg * 3, 6);
    expect(opp4!.gasCost).toBeCloseTo(config.gasPerLeg * 4, 6);
  });
});
