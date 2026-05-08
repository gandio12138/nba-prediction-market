import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Position as ClientPosition } from "../client-polymarket.js";

// ---------------------------------------------------------------------------
// State module contract types
// ---------------------------------------------------------------------------
// These define the interface state.ts must satisfy. The implementation
// exports matching types and functions — tests assert against this contract.

interface TrackedOrder {
  id: string;
  marketId: string;
  tokenId: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  status: "open" | "partial" | "filled" | "cancelled";
  filledSize: number;
  createdAt: string;
  updatedAt: string;
}

interface TrackedPosition {
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
}

interface StrategyState {
  lastPollAt: string | null;
  isRunning: boolean;
  signalsProcessed: number;
}

interface PipelineState {
  orders: TrackedOrder[];
  positions: TrackedPosition[];
  strategy: StrategyState;
  lastUpdated: string;
}

// Function signatures for dynamic import
type ReadStateFn = (path: string) => Promise<PipelineState>;
type WriteStateFn = (
  path: string,
  state: PipelineState,
) => Promise<void>;
type CreateEmptyStateFn = () => PipelineState;
type ReconcilePositionsFn = (
  state: PipelineState,
  apiPositions: ClientPosition[],
) => PipelineState;

let readState: ReadStateFn;
let writeState: WriteStateFn;
let createEmptyState: CreateEmptyStateFn;
let reconcilePositions: ReconcilePositionsFn;
let tmpDir: string;

beforeEach(async () => {
  vi.resetModules();
  tmpDir = await mkdtemp(join(tmpdir(), "state-test-"));
  const mod = await import("../state.js");
  readState = mod.readState;
  writeState = mod.writeState;
  createEmptyState = mod.createEmptyState;
  reconcilePositions = mod.reconcilePositions;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeOrder(
  overrides: Partial<TrackedOrder> = {},
): TrackedOrder {
  return {
    id: "order-1",
    marketId: "market-1",
    tokenId: "token-1",
    side: "buy",
    size: 50,
    price: 0.55,
    status: "open",
    filledSize: 0,
    createdAt: "2026-04-14T00:00:00.000Z",
    updatedAt: "2026-04-14T00:00:00.000Z",
    ...overrides,
  };
}

function makeTrackedPosition(
  overrides: Partial<TrackedPosition> = {},
): TrackedPosition {
  return {
    marketId: "market-1",
    outcomeId: "outcome-1",
    outcomeLabel: "Yes",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.6,
    unrealizedPnL: 10,
    ...overrides,
  };
}

function makeApiPosition(
  overrides: Partial<ClientPosition> = {},
): ClientPosition {
  return {
    marketId: "market-1",
    outcomeId: "outcome-1",
    outcomeLabel: "Yes",
    size: 100,
    entryPrice: 0.5,
    currentPrice: 0.6,
    unrealizedPnL: 10,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<PipelineState> = {},
): PipelineState {
  return {
    orders: [],
    positions: [],
    strategy: {
      lastPollAt: null,
      isRunning: false,
      signalsProcessed: 0,
    },
    lastUpdated: "2026-04-14T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createEmptyState
// ---------------------------------------------------------------------------
describe("createEmptyState", () => {
  it("returns state with empty arrays and default strategy", () => {
    const state = createEmptyState();

    expect(state.orders).toEqual([]);
    expect(state.positions).toEqual([]);
    expect(state.strategy.lastPollAt).toBeNull();
    expect(state.strategy.isRunning).toBe(false);
    expect(state.strategy.signalsProcessed).toBe(0);
    expect(state.lastUpdated).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// readState
// ---------------------------------------------------------------------------
describe("readState", () => {
  it("reads previously written state (roundtrip)", async () => {
    const filePath = join(tmpDir, "state.json");
    const original = makeState({
      orders: [makeOrder()],
      positions: [makeTrackedPosition()],
      strategy: {
        lastPollAt: "2026-04-14T12:00:00.000Z",
        isRunning: true,
        signalsProcessed: 42,
      },
    });

    await writeState(filePath, original);
    const loaded = await readState(filePath);

    expect(loaded).toEqual(original);
  });

  it("returns empty state for nonexistent file", async () => {
    const filePath = join(tmpDir, "missing.json");

    const state = await readState(filePath);

    expect(state.orders).toEqual([]);
    expect(state.positions).toEqual([]);
    expect(state.strategy.isRunning).toBe(false);
  });

  it("preserves order data integrity across roundtrip", async () => {
    const filePath = join(tmpDir, "orders.json");
    const order = makeOrder({
      id: "ord-abc",
      status: "partial",
      filledSize: 25,
      side: "sell",
    });
    const original = makeState({ orders: [order] });

    await writeState(filePath, original);
    const loaded = await readState(filePath);

    const loadedOrder = loaded.orders[0];
    expect(loadedOrder).toBeDefined();
    expect(loadedOrder!.id).toBe("ord-abc");
    expect(loadedOrder!.status).toBe("partial");
    expect(loadedOrder!.filledSize).toBe(25);
    expect(loadedOrder!.side).toBe("sell");
  });

  it("preserves multiple positions across roundtrip", async () => {
    const filePath = join(tmpDir, "multi.json");
    const positions = [
      makeTrackedPosition({ marketId: "m-1", size: 50 }),
      makeTrackedPosition({ marketId: "m-2", size: 75 }),
      makeTrackedPosition({ marketId: "m-3", size: 100 }),
    ];
    const original = makeState({ positions });

    await writeState(filePath, original);
    const loaded = await readState(filePath);

    expect(loaded.positions).toHaveLength(3);
    expect(loaded.positions[0]!.marketId).toBe("m-1");
    expect(loaded.positions[1]!.size).toBe(75);
    expect(loaded.positions[2]!.marketId).toBe("m-3");
  });

  it("returns empty state for corrupted JSON", async () => {
    const filePath = join(tmpDir, "corrupt.json");
    await writeFile(filePath, "{invalid json content !!!", "utf-8");

    const state = await readState(filePath);

    expect(state.orders).toEqual([]);
    expect(state.positions).toEqual([]);
  });

  it("returns empty state for truncated JSON", async () => {
    const filePath = join(tmpDir, "truncated.json");
    await writeFile(
      filePath,
      '{"orders":[{"id":"x"}],"positions',
      "utf-8",
    );

    const state = await readState(filePath);

    expect(state.orders).toEqual([]);
    expect(state.positions).toEqual([]);
  });

  it("returns empty state for empty file", async () => {
    const filePath = join(tmpDir, "empty.json");
    await writeFile(filePath, "", "utf-8");

    const state = await readState(filePath);

    expect(state.orders).toEqual([]);
    expect(state.positions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeState — atomic file operations
// ---------------------------------------------------------------------------
describe("writeState", () => {
  it("creates parent directories if needed", async () => {
    const filePath = join(tmpDir, "nested", "deep", "state.json");
    const state = makeState({ orders: [makeOrder()] });

    await writeState(filePath, state);
    const loaded = await readState(filePath);

    expect(loaded.orders).toHaveLength(1);
  });

  it("leaves no .tmp file after successful write", async () => {
    const filePath = join(tmpDir, "atomic.json");

    await writeState(filePath, makeState());

    const files = await readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("original file intact when stale .tmp exists", async () => {
    const filePath = join(tmpDir, "crash.json");
    const goodState = makeState({
      positions: [makeTrackedPosition({ size: 999 })],
    });

    await writeState(filePath, goodState);

    // Simulate a crash mid-write: leave a partial .tmp file
    await writeFile(filePath + ".tmp", "partial garbage", "utf-8");

    const loaded = await readState(filePath);
    expect(loaded.positions[0]!.size).toBe(999);
  });

  it("sequential writes preserve the latest state", async () => {
    const filePath = join(tmpDir, "sequential.json");

    await writeState(
      filePath,
      makeState({ lastUpdated: "first" }),
    );
    await writeState(
      filePath,
      makeState({ lastUpdated: "second" }),
    );
    await writeState(
      filePath,
      makeState({ lastUpdated: "third" }),
    );

    const loaded = await readState(filePath);
    expect(loaded.lastUpdated).toBe("third");
  });

  it("overwrites previous content completely", async () => {
    const filePath = join(tmpDir, "overwrite.json");
    const big = makeState({
      orders: [
        makeOrder({ id: "a" }),
        makeOrder({ id: "b" }),
        makeOrder({ id: "c" }),
      ],
    });
    const small = makeState({ orders: [makeOrder({ id: "only" })] });

    await writeState(filePath, big);
    await writeState(filePath, small);

    const loaded = await readState(filePath);
    expect(loaded.orders).toHaveLength(1);
    expect(loaded.orders[0]!.id).toBe("only");
  });
});

// ---------------------------------------------------------------------------
// reconcilePositions
// ---------------------------------------------------------------------------
describe("reconcilePositions", () => {
  it("adds new API positions not in local state", () => {
    const state = makeState();
    const apiPositions: ClientPosition[] = [
      makeApiPosition({
        marketId: "m-new",
        outcomeId: "o-new",
        size: 200,
      }),
    ];

    const reconciled = reconcilePositions(state, apiPositions);

    expect(reconciled.positions).toHaveLength(1);
    expect(reconciled.positions[0]!.marketId).toBe("m-new");
    expect(reconciled.positions[0]!.outcomeId).toBe("o-new");
    expect(reconciled.positions[0]!.size).toBe(200);
  });

  it("updates existing positions with fresh API data", () => {
    const state = makeState({
      positions: [
        makeTrackedPosition({
          marketId: "m-1",
          outcomeId: "o-1",
          currentPrice: 0.5,
          unrealizedPnL: 0,
        }),
      ],
    });
    const apiPositions: ClientPosition[] = [
      makeApiPosition({
        marketId: "m-1",
        outcomeId: "o-1",
        currentPrice: 0.75,
        unrealizedPnL: 25,
        size: 150,
      }),
    ];

    const reconciled = reconcilePositions(state, apiPositions);

    expect(reconciled.positions).toHaveLength(1);
    expect(reconciled.positions[0]!.currentPrice).toBe(0.75);
    expect(reconciled.positions[0]!.unrealizedPnL).toBe(25);
    expect(reconciled.positions[0]!.size).toBe(150);
  });

  it("removes positions absent from API response", () => {
    const state = makeState({
      positions: [
        makeTrackedPosition({
          marketId: "m-1",
          outcomeId: "o-1",
        }),
        makeTrackedPosition({
          marketId: "m-2",
          outcomeId: "o-2",
        }),
      ],
    });
    const apiPositions: ClientPosition[] = [
      makeApiPosition({ marketId: "m-1", outcomeId: "o-1" }),
    ];

    const reconciled = reconcilePositions(state, apiPositions);

    expect(reconciled.positions).toHaveLength(1);
    expect(reconciled.positions[0]!.marketId).toBe("m-1");
  });

  it("clears all positions when API returns empty", () => {
    const state = makeState({
      positions: [
        makeTrackedPosition({ marketId: "m-1" }),
        makeTrackedPosition({ marketId: "m-2" }),
      ],
    });

    const reconciled = reconcilePositions(state, []);

    expect(reconciled.positions).toEqual([]);
  });

  it("populates from API when local state is empty", () => {
    const state = makeState();
    const apiPositions: ClientPosition[] = [
      makeApiPosition({
        marketId: "m-1",
        outcomeId: "o-1",
        size: 50,
      }),
      makeApiPosition({
        marketId: "m-2",
        outcomeId: "o-2",
        size: 75,
      }),
    ];

    const reconciled = reconcilePositions(state, apiPositions);

    expect(reconciled.positions).toHaveLength(2);
    expect(reconciled.positions[0]!.size).toBe(50);
    expect(reconciled.positions[1]!.size).toBe(75);
  });

  it("preserves orders and strategy during reconciliation", () => {
    const order = makeOrder({ id: "keep-me" });
    const strategy: StrategyState = {
      lastPollAt: "2026-04-14T12:00:00.000Z",
      isRunning: true,
      signalsProcessed: 99,
    };
    const state = makeState({
      orders: [order],
      strategy,
      positions: [makeTrackedPosition()],
    });

    const reconciled = reconcilePositions(state, []);

    expect(reconciled.orders).toHaveLength(1);
    expect(reconciled.orders[0]!.id).toBe("keep-me");
    expect(reconciled.strategy.signalsProcessed).toBe(99);
    expect(reconciled.strategy.isRunning).toBe(true);
  });
});
