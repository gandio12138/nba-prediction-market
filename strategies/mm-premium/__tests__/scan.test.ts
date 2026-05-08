import { describe, it, expect, vi } from "vitest";
import { scanMarkets } from "../scan.js";
import type { ScanDeps } from "../scan.js";
import type { MintPremiumSnapshot } from "../signal.js";
import {
  DEFAULT_MM_PREMIUM_CONFIG,
  type MintPremiumConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<MintPremiumConfig>,
): MintPremiumConfig {
  return { ...DEFAULT_MM_PREMIUM_CONFIG, ...overrides };
}

function makeSnapshot(
  overrides?: Partial<MintPremiumSnapshot>,
): MintPremiumSnapshot {
  return {
    conditionId: "cond-001",
    question: "Will X happen?",
    yesTokenId: "tok-yes-001",
    noTokenId: "tok-no-001",
    volume24h: 30_000,
    tradeCount1h: 15,
    bidAskSpread: 0.01,
    midpoint: 0.5,
    timeToCloseMs: 72 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeDeps(snapshots: MintPremiumSnapshot[]): ScanDeps {
  return {
    fetchSnapshots: vi.fn(async () => snapshots),
  };
}

// ---------------------------------------------------------------------------
// scanMarkets — orchestrates market fetch and TTL cutoff
// ---------------------------------------------------------------------------

describe("scanMarkets (mm-premium)", () => {
  it("calls fetchSnapshots once per scan", async () => {
    const deps = makeDeps([]);
    await scanMarkets(makeConfig(), deps);

    expect(deps.fetchSnapshots).toHaveBeenCalledOnce();
  });

  it("returns an empty array when fetchSnapshots yields none", async () => {
    const result = await scanMarkets(makeConfig(), makeDeps([]));

    expect(result).toEqual([]);
  });

  it("passes through snapshots with timeToClose >= 24h", async () => {
    const snap = makeSnapshot({
      timeToCloseMs: 72 * 60 * 60 * 1000,
    });
    const result = await scanMarkets(makeConfig(), makeDeps([snap]));

    expect(result).toHaveLength(1);
    expect(result[0]!.conditionId).toBe("cond-001");
  });

  it("drops snapshots with timeToClose < 24h (market-close cutoff)", async () => {
    const snap = makeSnapshot({
      timeToCloseMs: 12 * 60 * 60 * 1000,
    });
    const result = await scanMarkets(makeConfig(), makeDeps([snap]));

    expect(result).toHaveLength(0);
  });

  it("respects a configured timeToCloseRejectMs threshold", async () => {
    const snap = makeSnapshot({
      timeToCloseMs: 30 * 60 * 60 * 1000,
    });
    // Bump the cutoff above this snapshot's timeToClose.
    const cfg = makeConfig({
      timeToCloseRejectMs: 36 * 60 * 60 * 1000,
    });
    const result = await scanMarkets(cfg, makeDeps([snap]));

    expect(result).toHaveLength(0);
  });

  it("keeps snapshots with timeToClose exactly at the cutoff", async () => {
    const cutoff = DEFAULT_MM_PREMIUM_CONFIG.timeToCloseRejectMs;
    const snap = makeSnapshot({ timeToCloseMs: cutoff });
    const result = await scanMarkets(makeConfig(), makeDeps([snap]));

    expect(result).toHaveLength(1);
  });

  it("processes multiple snapshots independently", async () => {
    const viable = makeSnapshot({
      conditionId: "cond-A",
      timeToCloseMs: 72 * 60 * 60 * 1000,
    });
    const closing = makeSnapshot({
      conditionId: "cond-B",
      timeToCloseMs: 6 * 60 * 60 * 1000,
    });
    const result = await scanMarkets(
      makeConfig(),
      makeDeps([viable, closing]),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.conditionId).toBe("cond-A");
  });

  it("preserves snapshot fields unchanged for downstream signal eval", async () => {
    const snap = makeSnapshot({
      volume24h: 60_000,
      tradeCount1h: 20,
      bidAskSpread: 0.008,
      midpoint: 0.42,
    });
    const result = await scanMarkets(makeConfig(), makeDeps([snap]));

    expect(result).toHaveLength(1);
    const kept = result[0]!;
    expect(kept.volume24h).toBe(60_000);
    expect(kept.tradeCount1h).toBe(20);
    expect(kept.bidAskSpread).toBeCloseTo(0.008, 4);
    expect(kept.midpoint).toBeCloseTo(0.42, 4);
  });
});
