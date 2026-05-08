import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TradeSignal } from "../types/TradeSignal.js";
import type {
  RiskDecision,
  Portfolio,
  AutomationExposure,
} from "../types/RiskInterface.js";
import type { ExecutionLogEntry } from "../execution-log.js";
import type {
  Position as ClientPosition,
  OrderResponse,
} from "../client-polymarket.js";

// ---------------------------------------------------------------------------
// Mock the Polymarket client — single point of external dependency
// ---------------------------------------------------------------------------

const mockCancelOrder = vi.hoisted(() => vi.fn());
const mockFetchPositions = vi.hoisted(() => vi.fn());
const mockCreateOrder = vi.hoisted(() => vi.fn());

vi.mock("../client-polymarket.js", () => ({
  cancelOrder: mockCancelOrder,
  fetchPositions: mockFetchPositions,
  createOrder: mockCreateOrder,
}));

// ---------------------------------------------------------------------------
// Real module imports (these use the mocked client where applicable)
// ---------------------------------------------------------------------------

import { createRunner } from "../runner.js";
import {
  readState,
  writeState,
  reconcilePositions,
  createEmptyState,
} from "../state.js";
import { appendEntry, getLogPath } from "../execution-log.js";
import { activateKillSwitch } from "../kill-switch.js";
import { aggregatePortfolio } from "../position-manager.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSignal(
  overrides: Partial<TradeSignal> = {},
): TradeSignal {
  return {
    automation_id: "e2e-strategy-v1",
    timestamp: new Date("2026-04-14T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "market-e2e",
      question: "Will event X happen?",
    },
    direction: "buy_yes",
    size: 50,
    confidence: 0.85,
    urgency: "normal",
    metadata: { source: "e2e-test" },
    ...overrides,
  };
}

function makeApiPosition(
  overrides: Partial<ClientPosition> = {},
): ClientPosition {
  return {
    marketId: "market-e2e",
    outcomeId: "token-yes-e2e",
    outcomeLabel: "Yes",
    size: 50,
    entryPrice: 0.6,
    currentPrice: 0.65,
    unrealizedPnL: 2.5,
    ...overrides,
  };
}

function makeOrderResponse(
  overrides: Partial<OrderResponse> = {},
): OrderResponse {
  return {
    id: "order-e2e-1",
    marketId: "market-e2e",
    outcomeId: "token-yes-e2e",
    side: "buy",
    type: "limit",
    amount: 50,
    price: 0.6,
    status: "open",
    filled: 0,
    remaining: 50,
    ...overrides,
  };
}

const DEFAULT_EXPOSURE: AutomationExposure = {
  total_capital_deployed: 0,
  position_count: 0,
  largest_position: 0,
  markets: [],
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("end-to-end pipeline", () => {
  let tmpDir: string;
  let statePath: string;
  let sigintSnapshot: Function[];

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date("2026-04-14T12:00:00Z") });
    tmpDir = await mkdtemp(join(tmpdir(), "e2e-pipeline-"));
    statePath = join(tmpDir, "state.json");
    sigintSnapshot = [...process.listeners("SIGINT")];

    mockCancelOrder.mockReset();
    mockFetchPositions.mockReset();
    mockCreateOrder.mockReset();
  });

  afterEach(async () => {
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Run one full pipeline cycle: signal → risk → order → reconcile.
   *
   * Returns collected log entries, deps, and final persisted state for
   * assertion by individual test cases.
   */
  async function runFullPipeline(options?: {
    signals?: TradeSignal[];
    riskDecision?: RiskDecision;
    orderResponse?: OrderResponse;
    apiPositions?: ClientPosition[];
  }) {
    const signals = options?.signals ?? [makeSignal()];
    const riskDecision: RiskDecision = options?.riskDecision ?? {
      approved: true,
    };
    const orderResponse =
      options?.orderResponse ?? makeOrderResponse();
    const apiPositions =
      options?.apiPositions ?? [makeApiPosition()];

    mockCreateOrder.mockResolvedValue(orderResponse);
    mockFetchPositions.mockResolvedValue(apiPositions);

    let currentPortfolio: Portfolio = {
      total_value: 10_000,
      positions: [],
      daily_pnl: 0,
    };

    const submittedOrderIds: string[] = [];
    const collectedEntries: ExecutionLogEntry[] = [];

    const deps = {
      strategy: vi.fn().mockResolvedValue(signals),
      risk: {
        preTradeCheck: vi.fn().mockReturnValue(riskDecision),
        getExposure: vi.fn().mockReturnValue(DEFAULT_EXPOSURE),
        onCircuitBreaker: vi.fn(),
      },
      executor: {
        submit: vi.fn().mockImplementation(async () => {
          submittedOrderIds.push(orderResponse.id);
          return {
            id: orderResponse.id,
            status: orderResponse.status,
          };
        }),
      },
      positions: {
        reconcile: vi.fn().mockImplementation(async () => {
          currentPortfolio = aggregatePortfolio(apiPositions);
          return currentPortfolio;
        }),
        getPortfolio: vi
          .fn()
          .mockImplementation(() => currentPortfolio),
      },
      log: vi
        .fn()
        .mockImplementation((entry: ExecutionLogEntry) => {
          collectedEntries.push(entry);
          appendEntry(tmpDir, entry);
        }),
    };

    const config = {
      pollIntervalMs: 100,
      dryRun: false,
      baseDir: tmpDir,
      statePath,
    };

    const runner = createRunner(config, deps);

    // Run one cycle then stop
    const done = runner.start();
    await vi.advanceTimersByTimeAsync(0);
    runner.stop();
    await vi.advanceTimersByTimeAsync(config.pollIntervalMs);
    await done;

    // Persist state after the cycle (simulates integration layer)
    const state = reconcilePositions(
      {
        ...createEmptyState(),
        orders: submittedOrderIds.map((id) => ({
          id,
          marketId: orderResponse.marketId,
          tokenId: orderResponse.outcomeId,
          side: orderResponse.side,
          size: orderResponse.amount,
          price: orderResponse.price,
          status: "open" as const,
          filledSize: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })),
        strategy: {
          lastPollAt: new Date().toISOString(),
          isRunning: false,
          signalsProcessed: signals.length,
        },
      },
      apiPositions,
    );
    await writeState(statePath, state);

    return { collectedEntries, deps, submittedOrderIds, state };
  }

  // -----------------------------------------------------------------------
  // Full pipeline flow
  // -----------------------------------------------------------------------

  it("signal → risk check → order submit → position update", async () => {
    const { deps, submittedOrderIds, state } =
      await runFullPipeline();

    expect(deps.strategy).toHaveBeenCalledOnce();
    expect(deps.risk.preTradeCheck).toHaveBeenCalledOnce();
    expect(deps.executor.submit).toHaveBeenCalledOnce();
    expect(submittedOrderIds).toEqual(["order-e2e-1"]);
    expect(deps.positions.reconcile).toHaveBeenCalledOnce();

    expect(state.orders).toHaveLength(1);
    expect(state.orders[0]!.id).toBe("order-e2e-1");
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]!.marketId).toBe("market-e2e");
    expect(state.strategy.signalsProcessed).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Execution log — valid JSONL for every decision
  // -----------------------------------------------------------------------

  it("produces valid JSONL entries for every pipeline decision", async () => {
    const { collectedEntries } = await runFullPipeline();

    const types = collectedEntries.map((e) => e.type);
    expect(types).toContain("signal");
    expect(types).toContain("risk_check");
    expect(types).toContain("order_submit");

    for (const entry of collectedEntries) {
      expect(entry.timestamp).toBeTruthy();
      expect(entry.automation_id).toBe("e2e-strategy-v1");
      expect(entry.market_id).toBe("market-e2e");
      expect(entry.data).toBeDefined();
    }

    // Verify the JSONL file on disk
    const logPath = getLogPath(
      tmpDir,
      new Date("2026-04-14T12:00:00Z"),
    );
    const logContent = await readFile(logPath, "utf-8");
    const lines = logContent.trim().split("\n");
    expect(lines).toHaveLength(collectedEntries.length);

    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed["type"]).toBeTruthy();
      expect(parsed["timestamp"]).toBeTruthy();
      expect(parsed["automation_id"]).toBeTruthy();
      expect(parsed["market_id"]).toBeTruthy();
    }
  });

  // -----------------------------------------------------------------------
  // State file contents
  // -----------------------------------------------------------------------

  it("state file survives read-back with correct data", async () => {
    await runFullPipeline();

    const loaded = await readState(statePath);
    expect(loaded.orders).toHaveLength(1);
    expect(loaded.orders[0]!.id).toBe("order-e2e-1");
    expect(loaded.orders[0]!.status).toBe("open");
    expect(loaded.positions).toHaveLength(1);
    expect(loaded.positions[0]!.marketId).toBe("market-e2e");
    expect(loaded.positions[0]!.size).toBe(50);
    expect(loaded.positions[0]!.currentPrice).toBe(0.65);
    expect(loaded.strategy.signalsProcessed).toBe(1);
    expect(loaded.lastUpdated).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Kill switch — cancel orders + close positions
  // -----------------------------------------------------------------------

  it("kill switch cancels orders and closes positions", async () => {
    const { submittedOrderIds } = await runFullPipeline();

    // Configure mock responses for kill switch phase
    mockCancelOrder.mockResolvedValue(
      makeOrderResponse({ status: "cancelled" }),
    );
    mockFetchPositions.mockResolvedValue([makeApiPosition()]);
    mockCreateOrder.mockResolvedValue(
      makeOrderResponse({
        id: "close-order-1",
        side: "sell",
        status: "filled",
      }),
    );

    const result = await activateKillSwitch(submittedOrderIds, {
      closePositions: true,
      reason: "E2E test shutdown",
    });

    expect(result.cancelResult.cancelled).toEqual(["order-e2e-1"]);
    expect(result.cancelResult.failed).toEqual([]);
    expect(result.closeResult).not.toBeNull();
    expect(result.closeResult!.closed).toHaveLength(1);

    // Reconcile state after kill switch (all positions closed)
    const preState = await readState(statePath);
    const finalState = reconcilePositions(preState, []);
    await writeState(statePath, {
      ...finalState,
      orders: finalState.orders.map((o) => ({
        ...o,
        status: "cancelled" as const,
      })),
    });

    const loaded = await readState(statePath);
    expect(loaded.positions).toHaveLength(0);
    expect(loaded.orders[0]!.status).toBe("cancelled");
  });

  it("kill switch triggers circuit breaker on risk interface", async () => {
    const { submittedOrderIds } = await runFullPipeline();

    mockCancelOrder.mockResolvedValue(
      makeOrderResponse({ status: "cancelled" }),
    );

    const risk = {
      preTradeCheck: vi
        .fn()
        .mockReturnValue({ approved: true }),
      getExposure: vi.fn().mockReturnValue(DEFAULT_EXPOSURE),
      onCircuitBreaker: vi.fn(),
    };

    const result = await activateKillSwitch(submittedOrderIds, {
      reason: "Max loss reached",
      riskInterface: risk,
    });

    expect(result.circuitBreakerTriggered).toBe(true);
    expect(risk.onCircuitBreaker).toHaveBeenCalledWith(
      "Max loss reached",
    );
  });

  // -----------------------------------------------------------------------
  // Rejected signal — risk gate blocks order submission
  // -----------------------------------------------------------------------

  it("rejected signal logs risk_check but skips order submission", async () => {
    const { collectedEntries, deps } = await runFullPipeline({
      riskDecision: {
        approved: false,
        rejection_reason: "position limit exceeded",
      },
    });

    expect(deps.risk.preTradeCheck).toHaveBeenCalledOnce();
    expect(deps.executor.submit).not.toHaveBeenCalled();

    const types = collectedEntries.map((e) => e.type);
    expect(types).toContain("signal");
    expect(types).toContain("risk_check");
    expect(types).not.toContain("order_submit");

    const riskEntry = collectedEntries.find(
      (e) => e.type === "risk_check",
    );
    expect(riskEntry).toBeDefined();
    expect(riskEntry!.data["approved"]).toBe(false);
    expect(riskEntry!.data["rejection_reason"]).toBe(
      "position limit exceeded",
    );
  });

  // -----------------------------------------------------------------------
  // Multiple signals in a single cycle
  // -----------------------------------------------------------------------

  it("processes multiple signals through the full pipeline", async () => {
    const signalA = makeSignal({
      market: {
        platform: "polymarket",
        market_id: "mkt-A",
        question: "Market A?",
      },
    });
    const signalB = makeSignal({
      market: {
        platform: "polymarket",
        market_id: "mkt-B",
        question: "Market B?",
      },
    });

    const { collectedEntries, deps, submittedOrderIds } =
      await runFullPipeline({ signals: [signalA, signalB] });

    expect(deps.risk.preTradeCheck).toHaveBeenCalledTimes(2);
    expect(deps.executor.submit).toHaveBeenCalledTimes(2);
    expect(submittedOrderIds).toHaveLength(2);

    // Each signal produces signal + risk_check + order_submit = 3 entries
    const signalEntries = collectedEntries.filter(
      (e) => e.type === "signal",
    );
    const riskEntries = collectedEntries.filter(
      (e) => e.type === "risk_check",
    );
    const orderEntries = collectedEntries.filter(
      (e) => e.type === "order_submit",
    );
    expect(signalEntries).toHaveLength(2);
    expect(riskEntries).toHaveLength(2);
    expect(orderEntries).toHaveLength(2);
  });
});
