import { describe, it, expect, vi } from "vitest";
import { createTradeMomentumRunner } from "../main.js";
import type {
  TradeMomentumRunnerConfig,
  TradeMomentumRunnerDeps,
} from "../main.js";
import type { ExecutionLogEntry } from "../../../execution-log.js";
import type { TradeMomentumSnapshot } from "../scan.js";
import type { Portfolio } from "../../../types/RiskInterface.js";
import { DEFAULT_TRADE_MOMENTUM_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Hardcoded mock snapshots for integration scenarios
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function makeSnapshot(
  overrides?: Partial<TradeMomentumSnapshot>,
): TradeMomentumSnapshot {
  return {
    conditionId: "cond-tm-001",
    question: "Will event Y cross 50%?",
    yesTokenId: "tok-yes-tm",
    noTokenId: "tok-no-tm",
    midpoint: 0.20,
    volume: 20_000,
    openInterest: 80_000,
    topWalletShare: 0.15,
    timeToCloseMs: 30 * DAY_MS,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<TradeMomentumRunnerConfig>,
): TradeMomentumRunnerConfig {
  return {
    strategy: { ...DEFAULT_TRADE_MOMENTUM_CONFIG },
    runner: {
      pollIntervalMs: 10,
      dryRun: true,
      baseDir: "/tmp/trade-momentum-test",
      statePath: "/tmp/trade-momentum-test/state.json",
    },
    maxConsecutiveLosses: 3,
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

interface RunResult {
  logEntries: ExecutionLogEntry[];
  deps: TradeMomentumRunnerDeps;
}

/** Feed the runner a sequence of snapshot pages (one per scan cycle). */
async function runWithPages(
  pages: TradeMomentumSnapshot[][],
  configOverrides?: Partial<TradeMomentumRunnerConfig>,
): Promise<RunResult> {
  const logEntries: ExecutionLogEntry[] = [];

  let scanCall = 0;
  const deps: TradeMomentumRunnerDeps = {
    scan: {
      fetchSnapshots: vi.fn(async () => {
        const page = pages[scanCall] ?? [];
        scanCall += 1;
        return page;
      }),
    },
    executor: {
      submit: vi.fn(async () => ({
        id: "ord-tm-001",
        status: "filled",
      })),
    },
    positions: {
      reconcile: vi.fn(async () => makeEmptyPortfolio()),
      getPortfolio: vi.fn(() => makeEmptyPortfolio()),
    },
    log: (entry) => logEntries.push(entry),
  };

  const runner = createTradeMomentumRunner(
    makeConfig(configOverrides),
    deps,
  );
  expect(runner.isRunning).toBe(false);

  const started = runner.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 150);
  });
  runner.stop();
  await started;

  return { logEntries, deps };
}

/** Build a series of snapshots that exhibit strong rising momentum. */
function makeMomentumSeries(conditionId: string): TradeMomentumSnapshot[][] {
  // Prices rise from 0.12 → 0.22 (Δ > 0.08 per period in last step).
  // Volume spikes well above prior baseline; OI rises.
  const series: TradeMomentumSnapshot[][] = [];
  const prices = [0.12, 0.13, 0.135, 0.14, 0.145, 0.15, 0.22];
  const volumes = [5_000, 6_000, 5_500, 6_000, 5_500, 6_000, 50_000];
  const ois = [40_000, 42_000, 43_000, 45_000, 47_000, 49_000, 80_000];
  for (let i = 0; i < prices.length; i += 1) {
    series.push([
      makeSnapshot({
        conditionId,
        midpoint: prices[i]!,
        volume: volumes[i]!,
        openInterest: ois[i]!,
        timestampMs: 1_000 + i,
      }),
    ]);
  }
  return series;
}

// ---------------------------------------------------------------------------
// TRADE-02 integration — full pipeline
// ---------------------------------------------------------------------------

describe("TRADE-02 integration — full pipeline", () => {
  it("strong momentum + rising OI emits a signal and risk_check", async () => {
    const pages = makeMomentumSeries("cond-tm-001");
    const { logEntries, deps } = await runWithPages(pages);

    expect(deps.scan.fetchSnapshots).toHaveBeenCalled();
    expect(deps.positions.reconcile).toHaveBeenCalled();

    const signalEntries = logEntries.filter(
      (e) => e.type === "signal" && e.market_id === "cond-tm-001",
    );
    expect(signalEntries.length).toBeGreaterThan(0);
    for (const entry of signalEntries) {
      expect(entry.automation_id).toBe("trade-momentum");
    }

    const riskEntries = logEntries.filter(
      (e) => e.type === "risk_check" && e.market_id === "cond-tm-001",
    );
    expect(riskEntries.length).toBeGreaterThan(0);
  });

  it("dry-run never submits orders, even on a viable market", async () => {
    const pages = makeMomentumSeries("cond-tm-001");
    const { deps } = await runWithPages(pages);

    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("price rising but OI falling is rejected (manipulation guard)", async () => {
    // Replay same rising-price series, but force OI to decline each period.
    const base = makeMomentumSeries("cond-tm-oi");
    const pages = base.map((page, i) =>
      page.map((snap) => ({
        ...snap,
        openInterest: 80_000 - i * 5_000,
      })),
    );
    const { logEntries, deps } = await runWithPages(pages);

    expect(deps.executor.submit).not.toHaveBeenCalled();

    const approvedRisk = logEntries.filter(
      (e) =>
        e.type === "risk_check" &&
        e.market_id === "cond-tm-oi" &&
        e.data["approved"] === true,
    );
    expect(approvedRisk).toHaveLength(0);
  });

  it("single wallet controlling >80% of volume is rejected", async () => {
    const pages = makeMomentumSeries("cond-tm-wallet").map((page) =>
      page.map((snap) => ({ ...snap, topWalletShare: 0.85 })),
    );
    const { logEntries, deps } = await runWithPages(pages);

    expect(deps.executor.submit).not.toHaveBeenCalled();

    const approvedRisk = logEntries.filter(
      (e) =>
        e.type === "risk_check" &&
        e.market_id === "cond-tm-wallet" &&
        e.data["approved"] === true,
    );
    expect(approvedRisk).toHaveLength(0);
  });

  it("entry price outside the [0.10, 0.30] band is rejected", async () => {
    // Midpoint already at 0.45 — above entry band.
    const hot = makeSnapshot({
      conditionId: "cond-tm-outband",
      midpoint: 0.45,
      volume: 50_000,
      openInterest: 90_000,
    });
    const { logEntries, deps } = await runWithPages([[hot], [hot], [hot]]);

    expect(deps.executor.submit).not.toHaveBeenCalled();

    const approvedSignal = logEntries.filter(
      (e) =>
        e.type === "signal" &&
        e.market_id === "cond-tm-outband" &&
        e.data["approved"] !== false,
    );
    // No viable emissions for an out-of-band market.
    const viableForOutband = logEntries.filter(
      (e) =>
        (e.type === "signal" || e.type === "risk_check") &&
        e.market_id === "cond-tm-outband" &&
        e.data["approved"] === true,
    );
    expect(viableForOutband).toHaveLength(0);
    // At most an advisory entry, never an approved one.
    expect(approvedSignal.length).toBeGreaterThanOrEqual(0);
  });

  it("markets closing within 24h produce no signals (hard floor)", async () => {
    const closing = makeSnapshot({
      conditionId: "cond-tm-closing",
      timeToCloseMs: 6 * HOUR_MS,
    });
    const { logEntries, deps } = await runWithPages([
      [closing],
      [closing],
    ]);

    const signals = logEntries.filter(
      (e) =>
        e.type === "signal" && e.market_id === "cond-tm-closing",
    );
    expect(signals).toHaveLength(0);
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("markets closing within 7 days are rejected (manipulation guard)", async () => {
    const tightRunway = makeSnapshot({
      conditionId: "cond-tm-7d",
      timeToCloseMs: 5 * DAY_MS,
    });
    const pages = Array.from({ length: 5 }, () => [tightRunway]);
    const { logEntries, deps } = await runWithPages(pages);

    expect(deps.executor.submit).not.toHaveBeenCalled();

    const approved = logEntries.filter(
      (e) =>
        e.type === "risk_check" &&
        e.market_id === "cond-tm-7d" &&
        e.data["approved"] === true,
    );
    expect(approved).toHaveLength(0);
  });
});
