import { describe, it, expect, vi } from "vitest";
import { createScanner } from "../scan.js";
import type { ScanDeps, TradeMomentumSnapshot } from "../scan.js";
import {
  DEFAULT_TRADE_MOMENTUM_CONFIG,
  type TradeMomentumConfig,
} from "../config.js";

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

function makeSnapshot(
  overrides?: Partial<TradeMomentumSnapshot>,
): TradeMomentumSnapshot {
  return {
    conditionId: "cond-001",
    question: "Will X happen?",
    yesTokenId: "tok-yes-001",
    noTokenId: "tok-no-001",
    midpoint: 0.20,
    volume: 15_000,
    openInterest: 50_000,
    topWalletShare: 0.15,
    timeToCloseMs: 30 * DAY_MS,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeDeps(
  pages: TradeMomentumSnapshot[][],
  nowValues?: number[],
): ScanDeps {
  let scanCall = 0;
  let nowCall = 0;
  return {
    fetchSnapshots: vi.fn(async () => {
      const page = pages[scanCall] ?? [];
      scanCall += 1;
      return page;
    }),
    now: nowValues
      ? vi.fn(() => {
          const v = nowValues[nowCall] ?? nowValues[nowValues.length - 1]!;
          nowCall += 1;
          return v;
        })
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// createScanner — orchestrates fetch, TTL cutoff, rolling-history accumulation
// ---------------------------------------------------------------------------

describe("createScanner (trade-momentum)", () => {
  it("returns a MarketContext per viable snapshot on first scan", async () => {
    const snap = makeSnapshot();
    const scanner = createScanner(makeConfig(), makeDeps([[snap]]));

    const contexts = await scanner.scan();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.snapshot.conditionId).toBe("cond-001");
  });

  it("first-scan history is empty (no prior periods)", async () => {
    const snap = makeSnapshot();
    const scanner = createScanner(makeConfig(), makeDeps([[snap]]));

    const contexts = await scanner.scan();

    expect(contexts[0]!.history).toEqual([]);
  });

  it("accumulates per-market history across successive scans", async () => {
    const period1 = makeSnapshot({ midpoint: 0.15, timestampMs: 1000 });
    const period2 = makeSnapshot({ midpoint: 0.22, timestampMs: 2000 });
    const period3 = makeSnapshot({ midpoint: 0.28, timestampMs: 3000 });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[period1], [period2], [period3]]),
    );

    await scanner.scan();
    await scanner.scan();
    const third = await scanner.scan();

    // Third scan sees two prior snapshots in history.
    expect(third).toHaveLength(1);
    expect(third[0]!.history).toHaveLength(2);
    expect(third[0]!.history[0]!.midpoint).toBeCloseTo(0.15, 4);
    expect(third[0]!.history[1]!.midpoint).toBeCloseTo(0.22, 4);
    expect(third[0]!.snapshot.midpoint).toBeCloseTo(0.28, 4);
  });

  it("caps rolling history at config.historyCap entries", async () => {
    const cap = 5;
    const pages: TradeMomentumSnapshot[][] = [];
    for (let i = 0; i < cap + 4; i += 1) {
      pages.push([
        makeSnapshot({ midpoint: 0.10 + i * 0.01, timestampMs: 1000 + i }),
      ]);
    }
    const scanner = createScanner(
      makeConfig({ historyCap: cap }),
      makeDeps(pages),
    );

    for (let i = 0; i < cap + 3; i += 1) {
      await scanner.scan();
    }
    const final = await scanner.scan();

    expect(final[0]!.history.length).toBeLessThanOrEqual(cap);
  });

  it("tracks distinct markets with independent histories", async () => {
    const a1 = makeSnapshot({ conditionId: "cond-A", midpoint: 0.15 });
    const b1 = makeSnapshot({ conditionId: "cond-B", midpoint: 0.25 });
    const a2 = makeSnapshot({ conditionId: "cond-A", midpoint: 0.20 });
    const b2 = makeSnapshot({ conditionId: "cond-B", midpoint: 0.28 });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[a1, b1], [a2, b2]]),
    );

    await scanner.scan();
    const second = await scanner.scan();

    const a = second.find((c) => c.snapshot.conditionId === "cond-A");
    const b = second.find((c) => c.snapshot.conditionId === "cond-B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.history).toHaveLength(1);
    expect(b!.history).toHaveLength(1);
    expect(a!.history[0]!.midpoint).toBeCloseTo(0.15, 4);
    expect(b!.history[0]!.midpoint).toBeCloseTo(0.25, 4);
  });

  it("drops markets with timeToCloseMs below the 24h hard floor", async () => {
    const tooClose = makeSnapshot({
      conditionId: "cond-close",
      timeToCloseMs: 12 * HOUR_MS,
    });
    const viable = makeSnapshot({
      conditionId: "cond-ok",
      timeToCloseMs: 30 * DAY_MS,
    });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[tooClose, viable]]),
    );

    const contexts = await scanner.scan();

    const ids = contexts.map((c) => c.snapshot.conditionId);
    expect(ids).toContain("cond-ok");
    expect(ids).not.toContain("cond-close");
  });

  it("prunes history entries older than signalTtlMs (TTL = 2 min)", async () => {
    const oldSnap = makeSnapshot({ timestampMs: 0 });
    const freshSnap = makeSnapshot({ timestampMs: 200_000 });
    // signalTtlMs default = 120_000. Advance 'now' so the oldSnap is stale
    // by the time we perform the second scan (now=250_000 → oldSnap age 250s).
    const nowValues = [0, 250_000];
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[oldSnap], [freshSnap]], nowValues),
    );

    await scanner.scan();
    const second = await scanner.scan();

    expect(second).toHaveLength(1);
    // Stale history entry pruned; only the current snapshot survives.
    expect(second[0]!.history).toEqual([]);
  });

  it("calls fetchSnapshots once per scan invocation", async () => {
    const deps = makeDeps([[], [], []]);
    const scanner = createScanner(makeConfig(), deps);

    await scanner.scan();
    await scanner.scan();
    await scanner.scan();

    expect(deps.fetchSnapshots).toHaveBeenCalledTimes(3);
  });
});
