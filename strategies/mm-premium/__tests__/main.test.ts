import { describe, it, expect, vi } from "vitest";
import { createMintPremiumRunner } from "../main.js";
import type {
  MintPremiumRunnerConfig,
  MintPremiumRunnerDeps,
} from "../main.js";
import type { ExecutionLogEntry } from "../../../execution-log.js";
import type { MintPremiumSnapshot } from "../signal.js";
import type { Portfolio } from "../../../types/RiskInterface.js";
import { DEFAULT_MM_PREMIUM_CONFIG } from "../config.js";

// ---------------------------------------------------------------------------
// Hardcoded mock snapshots — cover viable / low-volume / short-cycle cases.
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides?: Partial<MintPremiumSnapshot>,
): MintPremiumSnapshot {
  return {
    conditionId: "cond-mm-001",
    question: "Will the Lakers win Game 7?",
    yesTokenId: "tok-yes-mm",
    noTokenId: "tok-no-mm",
    volume24h: 30_000,
    tradeCount1h: 15,
    bidAskSpread: 0.01,
    midpoint: 0.5,
    timeToCloseMs: 72 * 60 * 60 * 1000,
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<MintPremiumRunnerConfig>,
): MintPremiumRunnerConfig {
  return {
    strategy: { ...DEFAULT_MM_PREMIUM_CONFIG },
    runner: {
      pollIntervalMs: 10,
      dryRun: true,
      baseDir: "/tmp/mm-premium-test",
      statePath: "/tmp/mm-premium-test/state.json",
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
  deps: MintPremiumRunnerDeps;
}

/** Run the runner once with the given snapshots and collect log entries. */
async function runOnce(
  snapshots: MintPremiumSnapshot[],
  configOverrides?: Partial<MintPremiumRunnerConfig>,
): Promise<RunResult> {
  const logEntries: ExecutionLogEntry[] = [];

  let scanCalls = 0;
  const deps: MintPremiumRunnerDeps = {
    scan: {
      fetchSnapshots: vi.fn(async () => {
        scanCalls += 1;
        return scanCalls === 1 ? snapshots : [];
      }),
    },
    executor: {
      submit: vi.fn(async () => ({
        id: "ord-mm-001",
        status: "filled",
      })),
    },
    positions: {
      reconcile: vi.fn(async () => makeEmptyPortfolio()),
      getPortfolio: vi.fn(() => makeEmptyPortfolio()),
    },
    log: (entry) => logEntries.push(entry),
  };

  const runner = createMintPremiumRunner(makeConfig(configOverrides), deps);
  expect(runner.isRunning).toBe(false);

  const started = runner.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  runner.stop();
  await started;

  return { logEntries, deps };
}

// ---------------------------------------------------------------------------
// MINT-04 integration — full pipeline
// ---------------------------------------------------------------------------

describe("MINT-04 integration — full pipeline", () => {
  it("viable market emits signal + risk_check, no orders submitted", async () => {
    const snap = makeSnapshot({
      volume24h: 30_000,
      tradeCount1h: 15,
      bidAskSpread: 0.01,
    });
    const { logEntries, deps } = await runOnce([snap]);

    // -- Scan layer called and reconciliation occurred --
    expect(deps.scan.fetchSnapshots).toHaveBeenCalled();
    expect(deps.positions.reconcile).toHaveBeenCalled();

    // -- At least one signal logged targeting the viable market --
    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries.length).toBeGreaterThan(0);
    for (const entry of signalEntries) {
      expect(entry.automation_id).toBe("mm-premium");
      expect(entry.market_id).toBe("cond-mm-001");
    }

    // -- Every emitted signal produces a matching risk_check --
    const riskEntries = logEntries.filter(
      (e) => e.type === "risk_check",
    );
    expect(riskEntries.length).toBe(signalEntries.length);

    // -- Dry-run: orders NOT submitted --
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("low-volume market emits downgrade advisory; no orders submitted", async () => {
    const snap = makeSnapshot({
      volume24h: 5_000, // below volumeDowngradeThreshold (10k)
      tradeCount1h: 5,
      bidAskSpread: 0.02,
    });
    const { logEntries, deps } = await runOnce([snap]);

    expect(deps.scan.fetchSnapshots).toHaveBeenCalled();

    // -- No orders submitted under any circumstances --
    expect(deps.executor.submit).not.toHaveBeenCalled();

    // -- An advisory marker should surface in the log, pointing to MINT-02 --
    const advisoryEntries = logEntries.filter((e) => {
      if (e.market_id !== "cond-mm-001") return false;
      const advisory = e.data["advisory"];
      const reason = e.data["reason"];
      return (
        (typeof advisory === "string" &&
          advisory.toLowerCase().includes("mint-02")) ||
        (typeof reason === "string" &&
          reason.toLowerCase().includes("mint-02"))
      );
    });
    expect(advisoryEntries.length).toBeGreaterThan(0);
  });

  it("market closing in <24h is excluded; no signals emitted", async () => {
    const snap = makeSnapshot({
      timeToCloseMs: 12 * 60 * 60 * 1000,
    });
    const { logEntries, deps } = await runOnce([snap]);

    const signalEntries = logEntries.filter(
      (e) =>
        e.type === "signal" && e.market_id === "cond-mm-001",
    );
    expect(signalEntries).toHaveLength(0);
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("dry-run mode never submits orders even on fully viable markets", async () => {
    const snap = makeSnapshot({
      volume24h: 80_000,
      tradeCount1h: 25,
      bidAskSpread: 0.005,
    });
    const { deps } = await runOnce([snap], {
      runner: {
        pollIntervalMs: 10,
        dryRun: true,
        baseDir: "/tmp/mm-premium-test",
        statePath: "/tmp/mm-premium-test/state.json",
      },
    });

    expect(deps.executor.submit).not.toHaveBeenCalled();
  });
});
