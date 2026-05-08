import { describe, it, expect } from "vitest";
import {
  divergenceTier,
  kellyFraction,
  evaluateFairValueOpportunity,
  StaticFairValueModel,
  type MarketSnapshot,
  type ModelOutput,
  type ProbabilityModel,
} from "../signal.js";
import {
  DEFAULT_FAIR_VALUE_CONFIG,
  type FairValueConfig,
} from "../config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeConfig(overrides?: Partial<FairValueConfig>): FairValueConfig {
  return { ...DEFAULT_FAIR_VALUE_CONFIG, ...overrides };
}

/** Rising volume across a 48h window — 2 buckets with strictly rising total. */
function risingVolume(n = 8, start = 500, step = 100): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

function flatVolume(n = 8, base = 500): number[] {
  return Array.from({ length: n }, () => base);
}

function makeSnapshot(overrides?: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    conditionId: "cond-001",
    question: "Will X happen?",
    marketPrice: 0.40,
    volume24h: 20_000,
    openInterest: 10_000,
    timeToCloseMs: 14 * DAY_MS,
    volumeHistory48h: risingVolume(),
    ...overrides,
  };
}

function makeModel(
  output: Partial<ModelOutput> & { fairValue: number },
): ProbabilityModel {
  return {
    computeFairValue: (): ModelOutput => ({
      sources: ["src-a", "src-b"],
      confidence: 0.8,
      ...output,
    }),
  };
}

// ---------------------------------------------------------------------------
// divergenceTier
// ---------------------------------------------------------------------------

describe("divergenceTier", () => {
  it("returns 'full' at or above 8pp", () => {
    expect(divergenceTier(0.08, makeConfig())).toBe("full");
    expect(divergenceTier(0.15, makeConfig())).toBe("full");
  });

  it("returns 'half' in the 5–8pp band", () => {
    expect(divergenceTier(0.05, makeConfig())).toBe("half");
    expect(divergenceTier(0.06, makeConfig())).toBe("half");
    expect(divergenceTier(0.0799, makeConfig())).toBe("half");
  });

  it("returns 'none' below 5pp", () => {
    expect(divergenceTier(0.03, makeConfig())).toBe("none");
    expect(divergenceTier(0, makeConfig())).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// kellyFraction
// ---------------------------------------------------------------------------

describe("kellyFraction", () => {
  it("matches the closed-form Kelly formula for a known input (fair > market)", () => {
    // fair=0.60, market=0.40 → f* = (0.6-0.4)/(1-0.4) = 0.333...
    // f_real = 0.333 * 0.25 haircut * 1.0 tier = 0.0833...
    const f = kellyFraction({
      fair: 0.60,
      market: 0.40,
      haircut: 0.25,
      sizingMultiplier: 1.0,
    });
    expect(f).toBeCloseTo(0.2 / 0.6 * 0.25, 6);
    expect(f).toBeCloseTo(0.08333, 4);
  });

  it("mirrors correctly when fair < market (buy NO case)", () => {
    // fair=0.30, market=0.50 → f* = (0.5-0.3)/0.5 = 0.4
    // f_real = 0.4 * 0.25 * 1.0 = 0.10
    const f = kellyFraction({
      fair: 0.30,
      market: 0.50,
      haircut: 0.25,
      sizingMultiplier: 1.0,
    });
    expect(f).toBeCloseTo(0.10, 6);
  });

  it("applies sizingMultiplier to halve the size on half-tier signals", () => {
    const full = kellyFraction({
      fair: 0.60,
      market: 0.40,
      haircut: 0.25,
      sizingMultiplier: 1.0,
    });
    const half = kellyFraction({
      fair: 0.60,
      market: 0.40,
      haircut: 0.25,
      sizingMultiplier: 0.5,
    });
    expect(half).toBeCloseTo(full * 0.5, 6);
  });

  it("returns 0 when there is no edge", () => {
    const f = kellyFraction({
      fair: 0.40,
      market: 0.40,
      haircut: 0.25,
      sizingMultiplier: 1.0,
    });
    expect(f).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateFairValueOpportunity
// ---------------------------------------------------------------------------

describe("evaluateFairValueOpportunity", () => {
  it("emits a full-tier signal when divergence is 15pp", () => {
    // fair=0.55, market=0.40 → |div|=0.15 → full tier.
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ marketPrice: 0.40 }),
      makeModel({ fairValue: 0.55, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(true);
    expect(result.tier).toBe("full");
    expect(result.sizingMultiplier).toBe(1.0);
    expect(result.absDivergence).toBeCloseTo(0.15, 6);
    expect(result.signal).toBeDefined();
    expect(result.signal!.direction).toBe("buy_yes");
    expect(result.signal!.metadata["tier"]).toBe("full");
    expect(result.signal!.metadata["sizingMultiplier"]).toBe(1.0);
    expect(result.signal!.metadata["limitOnly"]).toBe(true);
  });

  it("emits a half-tier signal with sizingMultiplier 0.5 when divergence is 6pp", () => {
    // fair=0.46, market=0.40 → |div|=0.06 → half tier.
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ marketPrice: 0.40 }),
      makeModel({ fairValue: 0.46, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(true);
    expect(result.tier).toBe("half");
    expect(result.sizingMultiplier).toBe(0.5);
    expect(result.signal).toBeDefined();
    expect(result.signal!.metadata["tier"]).toBe("half");
    expect(result.signal!.metadata["sizingMultiplier"]).toBe(0.5);
  });

  it("emits no signal when divergence is 3pp (below 5pp floor)", () => {
    // fair=0.43, market=0.40 → |div|=0.03 → none.
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ marketPrice: 0.40 }),
      makeModel({ fairValue: 0.43, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.tier).toBe("none");
    expect(result.signal).toBeUndefined();
    expect(result.reason).toMatch(/diverg|tier|threshold/i);
  });

  it("rejects when only one confluence criterion fires (divergence + 1 source + flat vol)", () => {
    // |div|=0.15 passes (a), but only one source fails (b), flat volume fails (c).
    // 1 of 3 < 2 → reject.
    const result = evaluateFairValueOpportunity(
      makeSnapshot({
        marketPrice: 0.40,
        volumeHistory48h: flatVolume(),
      }),
      makeModel({ fairValue: 0.55, sources: ["only-one"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.confluenceCount).toBeLessThan(2);
    expect(result.reason).toMatch(/confluence/i);
  });

  it("rejects when timeToClose < 7d hard floor", () => {
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ timeToCloseMs: 5 * DAY_MS }),
      makeModel({ fairValue: 0.55, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/close|time|runway|ttc/i);
  });

  it("rejects when volume_24h is below the liquidity floor", () => {
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ volume24h: 1_000 }),
      makeModel({ fairValue: 0.55, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/liquid|volume/i);
  });

  it("rejects when openInterest is below the liquidity floor", () => {
    const result = evaluateFairValueOpportunity(
      makeSnapshot({ openInterest: 500 }),
      makeModel({ fairValue: 0.55, sources: ["a", "b"] }),
      makeConfig(),
    );
    expect(result.viable).toBe(false);
    expect(result.reason).toMatch(/liquid|open.?interest|oi/i);
  });
});

// ---------------------------------------------------------------------------
// StaticFairValueModel (default, fixture-driven, no external fetches)
// ---------------------------------------------------------------------------

describe("StaticFairValueModel", () => {
  it("returns the fixture value for a known conditionId", () => {
    const model = new StaticFairValueModel({
      "cond-001": { fairValue: 0.62, sources: ["fixture"], confidence: 0.9 },
    });
    const out = model.computeFairValue({
      conditionId: "cond-001",
      marketPrice: 0.5,
      volume24h: 10_000,
      openInterest: 5_000,
      timeToCloseMs: 14 * DAY_MS,
      volumeHistory48h: risingVolume(),
    });
    expect(out.fairValue).toBe(0.62);
    expect(out.sources).toContain("fixture");
    expect(out.confidence).toBe(0.9);
  });

  it("falls back to a neutral (marketPrice, empty sources) output for unknown ids", () => {
    const model = new StaticFairValueModel({});
    const out = model.computeFairValue({
      conditionId: "unknown",
      marketPrice: 0.42,
      volume24h: 10_000,
      openInterest: 5_000,
      timeToCloseMs: 14 * DAY_MS,
      volumeHistory48h: risingVolume(),
    });
    expect(out.fairValue).toBe(0.42);
    expect(out.sources).toEqual([]);
  });
});
