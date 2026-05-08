import { describe, it, expect } from "vitest";
import {
  selectMarket,
  planLegs,
  shouldStopLoss,
  type MarketCandidate,
} from "../cycle.js";
import { DEFAULT_MINT_01_CONFIG, type Mint01Config } from "../config.js";

function makeConfig(overrides?: Partial<Mint01Config>): Mint01Config {
  return { ...DEFAULT_MINT_01_CONFIG, ...overrides };
}

function makeCandidate(
  overrides?: Partial<MarketCandidate>,
): MarketCandidate {
  return {
    conditionId: "0xcond-001",
    question: "Will the Lakers win?",
    midpoint: 0.5,
    timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
    volume_24h: 50_000,
    open_interest: 20_000,
    yesTokenId: "1234567890",
    noTokenId: "9876543210",
    ...overrides,
  };
}

describe("selectMarket", () => {
  it("returns the highest-volume candidate that passes all filters", () => {
    const c1 = makeCandidate({ conditionId: "c1", volume_24h: 12_000 });
    const c2 = makeCandidate({ conditionId: "c2", volume_24h: 80_000 });
    const c3 = makeCandidate({ conditionId: "c3", volume_24h: 30_000 });

    const result = selectMarket([c1, c2, c3], makeConfig());

    expect(result).not.toBeNull();
    expect(result?.candidate.conditionId).toBe("c2");
    expect(result?.volume24h).toBe(80_000);
  });

  it("returns null when no candidate passes the filters", () => {
    const tooLowVolume = makeCandidate({ volume_24h: 5_000 });
    const tooLowOI = makeCandidate({ open_interest: 1_000 });
    const tooSoon = makeCandidate({ timeToCloseMs: 24 * 60 * 60 * 1000 });

    const result = selectMarket(
      [tooLowVolume, tooLowOI, tooSoon],
      makeConfig(),
    );

    expect(result).toBeNull();
  });

  it("rejects candidates with degenerate midpoints (0 or 1)", () => {
    const atZero = makeCandidate({ conditionId: "edge0", midpoint: 0 });
    const atOne = makeCandidate({ conditionId: "edge1", midpoint: 1 });

    expect(selectMarket([atZero], makeConfig())).toBeNull();
    expect(selectMarket([atOne], makeConfig())).toBeNull();
  });

  it("rejects candidates missing CLOB token ids on either leg", () => {
    const noYes: MarketCandidate = {
      conditionId: "noYes",
      question: "?",
      midpoint: 0.5,
      timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
      volume_24h: 50_000,
      open_interest: 20_000,
      noTokenId: "no",
    };
    const noNo: MarketCandidate = {
      conditionId: "noNo",
      question: "?",
      midpoint: 0.5,
      timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
      volume_24h: 50_000,
      open_interest: 20_000,
      yesTokenId: "yes",
    };

    expect(selectMarket([noYes, noNo], makeConfig())).toBeNull();
  });

  it("accepts camelCase volume24h / openInterest fields", () => {
    const candidate: MarketCandidate = {
      conditionId: "camel",
      question: "?",
      midpoint: 0.5,
      timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
      volume24h: 25_000,
      openInterest: 15_000,
      yesTokenId: "yes",
      noTokenId: "no",
    };

    const result = selectMarket([candidate], makeConfig());

    expect(result?.candidate.conditionId).toBe("camel");
    expect(result?.volume24h).toBe(25_000);
    expect(result?.openInterest).toBe(15_000);
  });

  it("returns null on an empty input list", () => {
    expect(selectMarket([], makeConfig())).toBeNull();
  });
});

describe("planLegs", () => {
  it("places both legs at midpoint + premium with size = cycleCapital", () => {
    const legs = planLegs(0.5, makeConfig());

    expect(legs.yesPrice).toBeCloseTo(0.5075, 6);
    expect(legs.noPrice).toBeCloseTo(0.5075, 6);
    expect(legs.size).toBe(1_000);
  });

  it("derives the NO leg from the binary complement of the YES midpoint", () => {
    const legs = planLegs(0.3, makeConfig());

    // YES midpoint 0.30 → YES leg 0.3075
    // NO midpoint  0.70 → NO  leg 0.7075
    expect(legs.yesPrice).toBeCloseTo(0.3075, 6);
    expect(legs.noPrice).toBeCloseTo(0.7075, 6);
  });

  it("scales size with cycleCapital override", () => {
    const legs = planLegs(0.5, makeConfig({ cycleCapital: 2_500 }));

    expect(legs.size).toBe(2_500);
  });

  it("throws when midpoint is outside (0, 1)", () => {
    expect(() => planLegs(0, makeConfig())).toThrow(/0,\s*1/);
    expect(() => planLegs(1, makeConfig())).toThrow(/0,\s*1/);
    expect(() => planLegs(-0.1, makeConfig())).toThrow(/0,\s*1/);
    expect(() => planLegs(1.5, makeConfig())).toThrow(/0,\s*1/);
  });

  it("throws when premium pushes either leg above $1", () => {
    // YES midpoint 0.995 + premium 0.0075 = 1.0025 → unfillable.
    expect(() => planLegs(0.995, makeConfig())).toThrow(/>=\s*1/);
    // YES midpoint 0.005 → NO midpoint 0.995 → NO leg 1.0025.
    expect(() => planLegs(0.005, makeConfig())).toThrow(/>=\s*1/);
  });
});

describe("shouldStopLoss", () => {
  it("returns false when drift is within the threshold", () => {
    expect(shouldStopLoss(0.5, 0.52, makeConfig())).toBe(false);
    expect(shouldStopLoss(0.5, 0.48, makeConfig())).toBe(false);
  });

  it("returns true when YES midpoint drifts up past the threshold", () => {
    expect(shouldStopLoss(0.5, 0.56, makeConfig())).toBe(true);
  });

  it("returns true when YES midpoint drifts down past the threshold", () => {
    expect(shouldStopLoss(0.5, 0.44, makeConfig())).toBe(true);
  });

  it("respects per-config drift overrides", () => {
    const tightConfig = makeConfig({ stopLossDrift: 0.01 });
    expect(shouldStopLoss(0.5, 0.515, tightConfig)).toBe(true);
    expect(shouldStopLoss(0.5, 0.505, tightConfig)).toBe(false);
  });
});
