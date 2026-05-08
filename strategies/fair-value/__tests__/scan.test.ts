import { describe, it, expect, vi } from "vitest";
import { createScanner } from "../scan.js";
import type {
  FairValueSnapshot,
  ScanDeps,
  ProbabilityModel,
} from "../scan.js";
import {
  DEFAULT_FAIR_VALUE_CONFIG,
  type FairValueConfig,
} from "../config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeConfig(
  overrides?: Partial<FairValueConfig>,
): FairValueConfig {
  return { ...DEFAULT_FAIR_VALUE_CONFIG, ...overrides };
}

function makeSnapshot(
  overrides?: Partial<FairValueSnapshot>,
): FairValueSnapshot {
  return {
    conditionId: "cond-fv-001",
    question: "Will X clear 50%?",
    yesTokenId: "tok-yes-001",
    noTokenId: "tok-no-001",
    marketPrice: 0.40,
    volume24h: 25_000,
    openInterest: 10_000,
    timeToCloseMs: 14 * DAY_MS,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeModel(
  fairValue = 0.55,
  sources: string[] = ["fixture-a", "fixture-b"],
  confidence = 0.7,
): ProbabilityModel {
  return {
    computeFairValue: vi.fn(() => ({ fairValue, sources, confidence })),
  };
}

function makeDeps(
  pages: FairValueSnapshot[][],
  model: ProbabilityModel,
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
    model,
    now: nowValues
      ? vi.fn(() => {
          const v = nowValues[nowCall] ?? nowValues[nowValues.length - 1]!;
          nowCall += 1;
          return v;
        })
      : undefined,
  };
}

describe("createScanner (fair-value)", () => {
  it("returns a candidate per viable snapshot on first scan", async () => {
    const snap = makeSnapshot();
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[snap]], makeModel()),
    );

    const candidates = await scanner.scan();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.snapshot.conditionId).toBe("cond-fv-001");
  });

  it("invokes the probability model once per viable snapshot", async () => {
    const model = makeModel(0.60);
    const snap = makeSnapshot();
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[snap]], model),
    );

    const candidates = await scanner.scan();

    expect(model.computeFairValue).toHaveBeenCalledTimes(1);
    expect(candidates[0]!.modelResult.fairValue).toBeCloseTo(0.60, 6);
    expect(candidates[0]!.modelResult.sources).toEqual([
      "fixture-a",
      "fixture-b",
    ]);
  });

  it("passes the snapshot and rolling history to the model", async () => {
    const model = makeModel();
    const p1 = makeSnapshot({ volume24h: 10_000, timestampMs: 1000 });
    const p2 = makeSnapshot({ volume24h: 20_000, timestampMs: 2000 });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[p1], [p2]], model),
    );

    await scanner.scan();
    await scanner.scan();

    const secondCall = (model.computeFairValue as ReturnType<typeof vi.fn>).mock
      .calls[1]![0];
    expect(secondCall.snapshot.volume24h).toBe(20_000);
    expect(secondCall.history).toHaveLength(1);
    expect(secondCall.history[0]!.volume24h).toBe(10_000);
  });

  it("does not invoke the model for markets inside the time floor", async () => {
    const model = makeModel();
    // 5 days < minTimeToCloseDays (7) — rejected before model call.
    const closing = makeSnapshot({
      conditionId: "cond-close",
      timeToCloseMs: 5 * DAY_MS,
    });
    const viable = makeSnapshot({
      conditionId: "cond-ok",
      timeToCloseMs: 14 * DAY_MS,
    });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[closing, viable]], model),
    );

    const candidates = await scanner.scan();

    const ids = candidates.map((c) => c.snapshot.conditionId);
    expect(ids).toContain("cond-ok");
    expect(ids).not.toContain("cond-close");
    expect(model.computeFairValue).toHaveBeenCalledTimes(1);
  });

  it("accumulates per-market history across successive scans", async () => {
    const model = makeModel();
    const p1 = makeSnapshot({ marketPrice: 0.30, timestampMs: 1000 });
    const p2 = makeSnapshot({ marketPrice: 0.35, timestampMs: 2000 });
    const p3 = makeSnapshot({ marketPrice: 0.40, timestampMs: 3000 });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[p1], [p2], [p3]], model),
    );

    await scanner.scan();
    await scanner.scan();
    const third = await scanner.scan();

    expect(third).toHaveLength(1);
    expect(third[0]!.history).toHaveLength(2);
    expect(third[0]!.history[0]!.marketPrice).toBeCloseTo(0.30, 6);
    expect(third[0]!.history[1]!.marketPrice).toBeCloseTo(0.35, 6);
  });

  it("tracks distinct markets with independent histories", async () => {
    const model = makeModel();
    const a1 = makeSnapshot({ conditionId: "cond-A", marketPrice: 0.20 });
    const b1 = makeSnapshot({ conditionId: "cond-B", marketPrice: 0.50 });
    const a2 = makeSnapshot({ conditionId: "cond-A", marketPrice: 0.25 });
    const b2 = makeSnapshot({ conditionId: "cond-B", marketPrice: 0.55 });
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[a1, b1], [a2, b2]], model),
    );

    await scanner.scan();
    const second = await scanner.scan();

    const a = second.find((c) => c.snapshot.conditionId === "cond-A");
    const b = second.find((c) => c.snapshot.conditionId === "cond-B");
    expect(a!.history).toHaveLength(1);
    expect(b!.history).toHaveLength(1);
    expect(a!.history[0]!.marketPrice).toBeCloseTo(0.20, 6);
    expect(b!.history[0]!.marketPrice).toBeCloseTo(0.50, 6);
  });

  it("prunes history entries older than signalTtlMs (24h TTL)", async () => {
    const model = makeModel();
    const old = makeSnapshot({ timestampMs: 0 });
    const fresh = makeSnapshot({ timestampMs: 25 * HOUR_MS });
    // now=0 on first scan, now=25h on second ⇒ old entry expired by TTL.
    const nowValues = [0, 25 * HOUR_MS];
    const scanner = createScanner(
      makeConfig(),
      makeDeps([[old], [fresh]], model, nowValues),
    );

    await scanner.scan();
    const second = await scanner.scan();

    expect(second).toHaveLength(1);
    expect(second[0]!.history).toEqual([]);
  });

  it("calls fetchSnapshots once per scan invocation", async () => {
    const model = makeModel();
    const deps = makeDeps([[], [], []], model);
    const scanner = createScanner(makeConfig(), deps);

    await scanner.scan();
    await scanner.scan();
    await scanner.scan();

    expect(deps.fetchSnapshots).toHaveBeenCalledTimes(3);
  });
});
