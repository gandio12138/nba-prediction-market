import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TradeSignal } from "../types/TradeSignal.js";
import type {
  RiskDecision,
  Portfolio,
  AutomationExposure,
} from "../types/RiskInterface.js";
import type { ExecutionLogEntry } from "../execution-log.js";

// ---------------------------------------------------------------------------
// Runner module contract types
// ---------------------------------------------------------------------------
// These define the interface runner.ts must satisfy. The implementation
// (item 12) exports matching types and functions — tests assert against
// this contract.

interface RunnerConfig {
  pollIntervalMs: number;
  dryRun: boolean;
  baseDir: string;
  statePath: string;
}

interface ExecutorDeps {
  submit(
    signal: TradeSignal,
  ): Promise<{ id: string; status: string }>;
}

interface PositionDeps {
  reconcile(): Promise<Portfolio>;
  getPortfolio(): Portfolio;
}

interface OrderOutcome {
  signal: TradeSignal;
  status: "submitted" | "rejected" | "error";
  orderId?: string;
  error?: string;
}

interface RunnerDeps {
  strategy: () => Promise<TradeSignal[]>;
  risk: {
    preTradeCheck(
      signal: TradeSignal,
      portfolio: Portfolio,
    ): RiskDecision;
    getExposure(): AutomationExposure;
    onCircuitBreaker(reason: string): void;
  };
  executor: ExecutorDeps;
  positions: PositionDeps;
  log: (entry: ExecutionLogEntry) => void;
  onOutcome?: (outcome: OrderOutcome) => void;
}

interface Runner {
  start(): Promise<void>;
  stop(): void;
  readonly isRunning: boolean;
}

type CreateRunnerFn = (config: RunnerConfig, deps: RunnerDeps) => Runner;

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeSignal(
  overrides: Partial<TradeSignal> = {},
): TradeSignal {
  return {
    automation_id: "test-v1",
    timestamp: new Date("2026-04-14T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "mkt-123",
      question: "Will X happen?",
    },
    direction: "buy_yes",
    size: 50,
    confidence: 0.85,
    urgency: "normal",
    metadata: {},
    ...overrides,
  };
}

function makePortfolio(
  overrides: Partial<Portfolio> = {},
): Portfolio {
  return {
    total_value: 10_000,
    positions: [],
    daily_pnl: 0,
    ...overrides,
  };
}

function makeConfig(
  overrides: Partial<RunnerConfig> = {},
): RunnerConfig {
  return {
    pollIntervalMs: 100,
    dryRun: false,
    baseDir: "/tmp/runner-test",
    statePath: "/tmp/runner-test/state.json",
    ...overrides,
  };
}

function makeApproval(
  overrides: Partial<RiskDecision> = {},
): RiskDecision {
  return { approved: true, ...overrides };
}

const DEFAULT_EXPOSURE: AutomationExposure = {
  total_capital_deployed: 0,
  position_count: 0,
  largest_position: 0,
  markets: [],
};

function makeDeps() {
  const portfolio = makePortfolio();
  return {
    strategy: vi.fn().mockResolvedValue([]),
    risk: {
      preTradeCheck: vi.fn().mockReturnValue(makeApproval()),
      getExposure: vi.fn().mockReturnValue(DEFAULT_EXPOSURE),
      onCircuitBreaker: vi.fn(),
    },
    executor: {
      submit: vi
        .fn()
        .mockResolvedValue({ id: "ord-1", status: "open" }),
    },
    positions: {
      reconcile: vi.fn().mockResolvedValue(portfolio),
      getPortfolio: vi.fn().mockReturnValue(portfolio),
    },
    log: vi.fn(),
  };
}

/** Run a single poll cycle then stop. */
async function runOneCycle(
  runner: Runner,
  config: RunnerConfig,
): Promise<void> {
  const done = runner.start();
  await vi.advanceTimersByTimeAsync(0);
  runner.stop();
  await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
  await done;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let createRunner: CreateRunnerFn;
let sigintSnapshot: Function[];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  sigintSnapshot = [...process.listeners("SIGINT")];
  const mod = await import("../runner.js");
  createRunner = mod.createRunner;
});

afterEach(() => {
  // Remove SIGINT listeners added during the test
  for (const listener of process.listeners("SIGINT")) {
    if (!sigintSnapshot.includes(listener)) {
      process.removeListener(
        "SIGINT",
        listener as NodeJS.SignalsListener,
      );
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Poll loop lifecycle
// ---------------------------------------------------------------------------

describe("poll loop lifecycle", () => {
  it("calls strategy on first cycle immediately after start", async () => {
    const deps = makeDeps();
    const config = makeConfig();
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.strategy).toHaveBeenCalledTimes(1);

    runner.stop();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await done;
  });

  it("runs multiple cycles at poll interval", async () => {
    const deps = makeDeps();
    const config = makeConfig({ pollIntervalMs: 50 });
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0); // cycle 1
    await vi.advanceTimersByTimeAsync(50); // cycle 2
    await vi.advanceTimersByTimeAsync(50); // cycle 3

    expect(deps.strategy).toHaveBeenCalledTimes(3);

    runner.stop();
    await vi.advanceTimersByTimeAsync(50);
    await done;
  });

  it("stop halts the loop — no further strategy calls", async () => {
    const deps = makeDeps();
    const config = makeConfig({ pollIntervalMs: 50 });
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0); // cycle 1
    expect(deps.strategy).toHaveBeenCalledTimes(1);

    runner.stop();
    await vi.advanceTimersByTimeAsync(50);
    await done;

    // No further calls after stop
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.strategy).toHaveBeenCalledTimes(1);
  });

  it("start promise resolves after stop", async () => {
    const deps = makeDeps();
    const config = makeConfig();
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);

    runner.stop();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);

    await expect(done).resolves.toBeUndefined();
  });

  it("isRunning reflects loop state", async () => {
    const deps = makeDeps();
    const config = makeConfig();
    const runner = createRunner(config, deps);

    expect(runner.isRunning).toBe(false);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.isRunning).toBe(true);

    runner.stop();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await done;
    expect(runner.isRunning).toBe(false);
  });

  it("handles SIGINT for graceful shutdown", async () => {
    const deps = makeDeps();
    const config = makeConfig({ pollIntervalMs: 50 });
    const listenersBefore = process.listenerCount("SIGINT");

    const runner = createRunner(config, deps);
    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.isRunning).toBe(true);

    // Runner should have added a SIGINT listener
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(
      listenersBefore,
    );

    // Invoke the newest SIGINT listener to simulate the signal
    const listeners = process.listeners("SIGINT");
    const handler = listeners[listeners.length - 1];
    expect(handler).toBeDefined();
    (handler as () => void)();

    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await done;
    expect(runner.isRunning).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signal processing pipeline
// ---------------------------------------------------------------------------

describe("signal processing pipeline", () => {
  it("submits approved signal to executor", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.risk.preTradeCheck.mockReturnValue(makeApproval());

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.risk.preTradeCheck).toHaveBeenCalledWith(
      signal,
      expect.objectContaining({ total_value: expect.any(Number) }),
    );
    expect(deps.executor.submit).toHaveBeenCalledWith(signal);
  });

  it("does not submit rejected signals", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.risk.preTradeCheck.mockReturnValue({
      approved: false,
      rejection_reason: "exceeds position limit",
    });

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.risk.preTradeCheck).toHaveBeenCalled();
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("uses risk-modified size when present", async () => {
    const signal = makeSignal({ size: 100 });
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.risk.preTradeCheck.mockReturnValue(
      makeApproval({ modified_size: 25 }),
    );

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.executor.submit).toHaveBeenCalledTimes(1);
    const submitted = deps.executor.submit.mock
      .calls[0]?.[0] as TradeSignal;
    expect(submitted).toBeDefined();
    expect(submitted.size).toBe(25);
  });

  it("logs signal, risk_check, and order_submit entries", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.risk.preTradeCheck.mockReturnValue(makeApproval());

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    const loggedTypes = (
      deps.log.mock.calls as [ExecutionLogEntry][]
    ).map((c) => c[0].type);
    expect(loggedTypes).toContain("signal");
    expect(loggedTypes).toContain("risk_check");
    expect(loggedTypes).toContain("order_submit");
  });

  it("processes multiple signals in a single cycle", async () => {
    const signalA = makeSignal({
      market: {
        platform: "polymarket",
        market_id: "mkt-A",
        question: "A?",
      },
    });
    const signalB = makeSignal({
      market: {
        platform: "polymarket",
        market_id: "mkt-B",
        question: "B?",
      },
    });
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signalA, signalB]);

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.risk.preTradeCheck).toHaveBeenCalledTimes(2);
    expect(deps.executor.submit).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Error recovery
// ---------------------------------------------------------------------------

describe("onOutcome callback", () => {
  it("fires with status=submitted after a successful executor.submit", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    const onOutcome = vi.fn();
    const config = makeConfig();
    const runner = createRunner(config, { ...deps, onOutcome });

    await runOneCycle(runner, config);

    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "submitted",
        orderId: "ord-1",
      }),
    );
  });

  it("fires with status=error when executor.submit throws", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.executor.submit.mockRejectedValueOnce(new Error("boom"));
    const onOutcome = vi.fn();
    const config = makeConfig();
    const runner = createRunner(config, { ...deps, onOutcome });

    await runOneCycle(runner, config);

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", error: "boom" }),
    );
  });

  it("fires with status=rejected when executor.submit returns rejected", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.executor.submit.mockResolvedValueOnce({
      id: "ord-x",
      status: "rejected",
    });
    const onOutcome = vi.fn();
    const config = makeConfig();
    const runner = createRunner(config, { ...deps, onOutcome });

    await runOneCycle(runner, config);

    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: "rejected" }),
    );
  });

  it("does not fire when the risk check rejects the signal", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.risk.preTradeCheck.mockReturnValue({
      approved: false,
      rejection_reason: "test",
    });
    const onOutcome = vi.fn();
    const config = makeConfig();
    const runner = createRunner(config, { ...deps, onOutcome });

    await runOneCycle(runner, config);

    expect(onOutcome).not.toHaveBeenCalled();
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });
});

describe("error recovery", () => {
  it("continues loop when strategy throws", async () => {
    const deps = makeDeps();
    deps.strategy
      .mockRejectedValueOnce(new Error("API timeout"))
      .mockResolvedValue([]);

    const config = makeConfig({ pollIntervalMs: 50 });
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0); // cycle 1 — throws
    await vi.advanceTimersByTimeAsync(50); // cycle 2 — succeeds

    expect(deps.strategy).toHaveBeenCalledTimes(2);

    runner.stop();
    await vi.advanceTimersByTimeAsync(50);
    await done;
  });

  it("continues loop when executor.submit throws", async () => {
    const signal = makeSignal();
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([signal]);
    deps.executor.submit
      .mockRejectedValueOnce(new Error("insufficient balance"))
      .mockResolvedValue({ id: "ord-2", status: "open" });

    const config = makeConfig({ pollIntervalMs: 50 });
    const runner = createRunner(config, deps);

    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0); // cycle 1 — submit throws
    await vi.advanceTimersByTimeAsync(50); // cycle 2 — succeeds

    expect(deps.executor.submit).toHaveBeenCalledTimes(2);

    runner.stop();
    await vi.advanceTimersByTimeAsync(50);
    await done;
  });

  it("logs error entry when strategy throws", async () => {
    const deps = makeDeps();
    deps.strategy.mockRejectedValueOnce(new Error("network down"));

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    const errorEntries = (
      deps.log.mock.calls as [ExecutionLogEntry][]
    ).filter((c) => c[0].type === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
  });

  it("logs error entry when executor.submit throws", async () => {
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([makeSignal()]);
    deps.executor.submit.mockRejectedValueOnce(
      new Error("rate limited"),
    );

    const config = makeConfig();
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    const errorEntries = (
      deps.log.mock.calls as [ExecutionLogEntry][]
    ).filter((c) => c[0].type === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe("dry-run mode", () => {
  it("never calls executor.submit in dry-run", async () => {
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([makeSignal()]);
    deps.risk.preTradeCheck.mockReturnValue(makeApproval());

    const config = makeConfig({ dryRun: true });
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("still runs risk checks in dry-run", async () => {
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([makeSignal()]);

    const config = makeConfig({ dryRun: true });
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    expect(deps.risk.preTradeCheck).toHaveBeenCalled();
  });

  it("logs signal and risk_check but not order_submit in dry-run", async () => {
    const deps = makeDeps();
    deps.strategy.mockResolvedValue([makeSignal()]);
    deps.risk.preTradeCheck.mockReturnValue(makeApproval());

    const config = makeConfig({ dryRun: true });
    const runner = createRunner(config, deps);
    await runOneCycle(runner, config);

    const loggedTypes = (
      deps.log.mock.calls as [ExecutionLogEntry][]
    ).map((c) => c[0].type);
    expect(loggedTypes).toContain("signal");
    expect(loggedTypes).toContain("risk_check");
    expect(loggedTypes).not.toContain("order_submit");
  });
});
