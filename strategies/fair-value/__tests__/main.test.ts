import { describe, it, expect, vi } from "vitest";
import { createFairValueRunner } from "../main.js";
import type {
  FairValueRunnerConfig,
  FairValueRunnerDeps,
} from "../main.js";
import type { ExecutionLogEntry } from "../../../execution-log.js";
import type {
  FairValueSnapshot,
  ProbabilityModel,
} from "../scan.js";
import type { Portfolio } from "../../../types/RiskInterface.js";
import { DEFAULT_FAIR_VALUE_CONFIG } from "../config.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

function makeConfig(
  overrides?: Partial<FairValueRunnerConfig>,
): FairValueRunnerConfig {
  return {
    strategy: { ...DEFAULT_FAIR_VALUE_CONFIG },
    runner: {
      pollIntervalMs: 10,
      dryRun: true,
      baseDir: "/tmp/fair-value-test",
      statePath: "/tmp/fair-value-test/state.json",
    },
    ...overrides,
  };
}

function makeEmptyPortfolio(): Portfolio {
  return {
    total_value: 10_000,
    positions: [],
    daily_pnl: 0,
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

interface RunResult {
  logEntries: ExecutionLogEntry[];
  deps: FairValueRunnerDeps;
}

async function runWithPages(
  pages: FairValueSnapshot[][],
  model: ProbabilityModel,
  configOverrides?: Partial<FairValueRunnerConfig>,
): Promise<RunResult> {
  const logEntries: ExecutionLogEntry[] = [];
  let scanCall = 0;

  const deps: FairValueRunnerDeps = {
    scan: {
      fetchSnapshots: vi.fn(async () => {
        const page = pages[scanCall] ?? [];
        scanCall += 1;
        return page;
      }),
      model,
    },
    executor: {
      submit: vi.fn(async () => ({
        id: "ord-fv-001",
        status: "filled",
      })),
    },
    positions: {
      reconcile: vi.fn(async () => makeEmptyPortfolio()),
      getPortfolio: vi.fn(() => makeEmptyPortfolio()),
    },
    log: (entry) => logEntries.push(entry),
  };

  const runner = createFairValueRunner(makeConfig(configOverrides), deps);
  expect(runner.isRunning).toBe(false);

  const started = runner.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 150);
  });
  runner.stop();
  await started;

  return { logEntries, deps };
}

/** Rising-volume series — satisfies the "volume_24h increasing 48h" leg. */
function makeRisingVolumeSeries(
  conditionId: string,
  marketPrice: number,
): FairValueSnapshot[][] {
  const volumes = [8_000, 12_000, 18_000, 26_000, 36_000];
  return volumes.map((v, i) => [
    makeSnapshot({
      conditionId,
      marketPrice,
      volume24h: v,
      timestampMs: 1_000 + i,
    }),
  ]);
}

describe("IA-03 integration — fair-value full pipeline", () => {
  it("divergence + 2 sources + rising volume emits a signal and risk_check", async () => {
    // market 0.40, fair 0.55 ⇒ 15pp divergence (full tier).
    const pages = makeRisingVolumeSeries("cond-fv-001", 0.40);
    const model = makeModel(0.55, ["src-a", "src-b"]);

    const { logEntries, deps } = await runWithPages(pages, model);

    expect(deps.scan.fetchSnapshots).toHaveBeenCalled();
    expect(deps.positions.reconcile).toHaveBeenCalled();

    const signals = logEntries.filter(
      (e) => e.type === "signal" && e.market_id === "cond-fv-001",
    );
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(s.automation_id).toBe("fair-value");
    }

    const riskEntries = logEntries.filter(
      (e) => e.type === "risk_check" && e.market_id === "cond-fv-001",
    );
    expect(riskEntries.length).toBeGreaterThan(0);
  });

  it("invokes the pluggable ProbabilityModel via the scan layer", async () => {
    const pages = makeRisingVolumeSeries("cond-fv-model", 0.40);
    const model = makeModel(0.55);

    await runWithPages(pages, model);

    expect(model.computeFairValue).toHaveBeenCalled();
  });

  it("dry-run never submits orders, even on a viable divergence", async () => {
    const pages = makeRisingVolumeSeries("cond-fv-dry", 0.40);
    const model = makeModel(0.55, ["src-a", "src-b"]);

    const { deps } = await runWithPages(pages, model);

    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("emitted signals record limit-only intent in metadata", async () => {
    const pages = makeRisingVolumeSeries("cond-fv-limit", 0.40);
    const model = makeModel(0.55, ["src-a", "src-b"]);

    const { logEntries } = await runWithPages(pages, model);

    const signal = logEntries.find(
      (e) => e.type === "signal" && e.market_id === "cond-fv-limit",
    );
    expect(signal).toBeDefined();
    // Limit-only intent is recorded in metadata (per Requirements).
    const md = signal!.data["metadata"] as Record<string, unknown> | undefined;
    expect(md).toBeDefined();
    expect(md!["orderType"]).toBe("limit");
  });

  it("sub-threshold divergence produces no approved signals", async () => {
    // 0.43 vs 0.40 ⇒ 3pp — below the 5pp floor.
    const pages = makeRisingVolumeSeries("cond-fv-sub", 0.40);
    const model = makeModel(0.43, ["src-a", "src-b"]);

    const { logEntries, deps } = await runWithPages(pages, model);

    expect(deps.executor.submit).not.toHaveBeenCalled();

    const approvedSignals = logEntries.filter(
      (e) =>
        e.type === "signal" &&
        e.market_id === "cond-fv-sub" &&
        e.data["approved"] === true,
    );
    expect(approvedSignals).toHaveLength(0);
  });

  it("markets closing within 7 days produce no signals (hard floor)", async () => {
    const closing = makeSnapshot({
      conditionId: "cond-fv-closing",
      timeToCloseMs: 5 * DAY_MS,
    });
    const model = makeModel(0.55, ["src-a", "src-b"]);

    const { logEntries, deps } = await runWithPages(
      [[closing], [closing], [closing]],
      model,
    );

    const signals = logEntries.filter(
      (e) => e.type === "signal" && e.market_id === "cond-fv-closing",
    );
    expect(signals).toHaveLength(0);
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("liquidity below minVolume24h/minOpenInterest is rejected", async () => {
    const thin = makeSnapshot({
      conditionId: "cond-fv-thin",
      volume24h: 1_000,
      openInterest: 500,
    });
    const model = makeModel(0.55, ["src-a", "src-b"]);

    const { logEntries, deps } = await runWithPages(
      [[thin], [thin], [thin]],
      model,
    );

    expect(deps.executor.submit).not.toHaveBeenCalled();
    const approved = logEntries.filter(
      (e) =>
        e.type === "risk_check" &&
        e.market_id === "cond-fv-thin" &&
        e.data["approved"] === true,
    );
    expect(approved).toHaveLength(0);
  });

  it("divergence with only 1 source and flat volume is rejected", async () => {
    // Flat volume (no increase) + 1 source ⇒ only leg (a) passes; <2 of 3.
    const flatPages: FairValueSnapshot[][] = Array.from(
      { length: 5 },
      (_, i) => [
        makeSnapshot({
          conditionId: "cond-fv-confluence",
          marketPrice: 0.40,
          volume24h: 20_000,
          timestampMs: 1_000 + i,
        }),
      ],
    );
    const model = makeModel(0.55, ["only-one"]);

    const { logEntries, deps } = await runWithPages(flatPages, model);

    expect(deps.executor.submit).not.toHaveBeenCalled();
    const approved = logEntries.filter(
      (e) =>
        e.type === "risk_check" &&
        e.market_id === "cond-fv-confluence" &&
        e.data["approved"] === true,
    );
    expect(approved).toHaveLength(0);
  });
});
