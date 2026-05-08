import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Portfolio } from "../types/RiskInterface.js";
import type {
  AccountBalance,
  OrderResponse,
  Position as ClientPosition,
} from "../client-polymarket.js";

// ---------------------------------------------------------------------------
// PositionDeps contract (matches runner.ts PositionDeps)
// ---------------------------------------------------------------------------

interface PositionDeps {
  reconcile(): Promise<Portfolio>;
  getPortfolio(): Portfolio;
  getOpenOrders(): OrderResponse[];
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchBalance = vi.fn();
const mockFetchPositions = vi.fn();
const mockFetchOpenOrders = vi.fn();

vi.mock("../client-polymarket.js", () => ({
  fetchBalance: mockFetchBalance,
  fetchPositions: mockFetchPositions,
  fetchOpenOrders: mockFetchOpenOrders,
}));

// ---------------------------------------------------------------------------
// Module under test — dynamically imported after mock setup
// ---------------------------------------------------------------------------

let createLivePositions: () => PositionDeps;

// All existing tests exercise the live SDK path (via mocks) and
// therefore need WALLET_PRIVATE_KEY set so reconcile() does not
// short-circuit to an empty portfolio. The no-wallet path has its own
// dedicated describe block below where this env is explicitly unset.
beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env["WALLET_PRIVATE_KEY"] = "0x" + "a".repeat(64);
  const mod = await import("../live-positions.js");
  createLivePositions = mod.createLivePositions;
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function clientPos(
  overrides?: Partial<ClientPosition>,
): ClientPosition {
  return {
    marketId: "0xabc",
    outcomeId: "tok-yes",
    outcomeLabel: "Yes",
    size: 100,
    entryPrice: 0.45,
    currentPrice: 0.55,
    unrealizedPnL: 10,
    ...overrides,
  };
}

function balance(
  overrides?: Partial<AccountBalance>,
): AccountBalance {
  return {
    currency: "USDC",
    total: 500,
    available: 500,
    locked: 0,
    ...overrides,
  };
}

function openOrder(
  overrides?: Partial<OrderResponse>,
): OrderResponse {
  return {
    id: "ord-1",
    marketId: "0xabc",
    outcomeId: "tok-yes",
    side: "buy",
    type: "limit",
    amount: 10,
    price: 0.5,
    status: "open",
    filled: 0,
    remaining: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------

describe("createLivePositions.reconcile", () => {
  it("calls fetchBalance, fetchPositions, and fetchOpenOrders", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance()]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    await deps.reconcile();

    expect(mockFetchBalance).toHaveBeenCalledOnce();
    expect(mockFetchPositions).toHaveBeenCalledOnce();
    expect(mockFetchOpenOrders).toHaveBeenCalledOnce();
  });

  it("assembles Portfolio with positions mapped from client", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance({ available: 0 })]);
    mockFetchPositions.mockResolvedValueOnce([
      clientPos({
        marketId: "0xabc",
        outcomeLabel: "Yes",
        size: 100,
        entryPrice: 0.40,
        currentPrice: 0.60,
        unrealizedPnL: 20,
      }),
      clientPos({
        marketId: "0xdef",
        outcomeLabel: "No",
        size: 50,
        entryPrice: 0.55,
        currentPrice: 0.45,
        unrealizedPnL: 5,
      }),
    ]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();

    expect(portfolio.positions).toHaveLength(2);

    const p0 = portfolio.positions[0]!;
    expect(p0.market_id).toBe("0xabc");
    expect(p0.direction).toBe("buy_yes");
    expect(p0.size).toBe(100);
    expect(p0.entry_price).toBe(0.40);

    const p1 = portfolio.positions[1]!;
    expect(p1.market_id).toBe("0xdef");
    expect(p1.direction).toBe("buy_no");
    expect(p1.size).toBe(50);
    expect(p1.entry_price).toBe(0.55);
  });

  it("total_value sums USDC available balance + mark-to-market position value", async () => {
    mockFetchBalance.mockResolvedValueOnce([
      balance({ currency: "USDC", available: 500 }),
    ]);
    mockFetchPositions.mockResolvedValueOnce([
      // 100 shares @ 0.60 = 60 USDC mark-to-market
      clientPos({ size: 100, currentPrice: 0.60 }),
      // 50 shares @ 0.40 = 20 USDC mark-to-market
      clientPos({ marketId: "0xdef", size: 50, currentPrice: 0.40 }),
    ]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();

    // 500 cash + 60 + 20 = 580
    expect(portfolio.total_value).toBeCloseTo(580);
  });

  it("daily_pnl sums unrealizedPnL across positions", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance()]);
    mockFetchPositions.mockResolvedValueOnce([
      clientPos({ unrealizedPnL: 15 }),
      clientPos({ marketId: "0xdef", unrealizedPnL: -4 }),
    ]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();

    expect(portfolio.daily_pnl).toBeCloseTo(11);
  });

  it("returns empty portfolio when no balance and no positions", async () => {
    mockFetchBalance.mockResolvedValueOnce([]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });

  it("ignores non-USDC balances when computing cash component", async () => {
    mockFetchBalance.mockResolvedValueOnce([
      balance({ currency: "USDC", available: 200 }),
      balance({ currency: "POL", available: 9_999 }),
    ]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();

    expect(portfolio.total_value).toBeCloseTo(200);
  });

  it("returns empty portfolio when fetchBalance fails with an auth error (dry-run path)", async () => {
    mockFetchBalance.mockRejectedValueOnce(
      new Error("AuthenticationError: credentials required"),
    );
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });

  it("treats 'is not iterable' rejection as auth-gated and returns empty portfolio", async () => {
    // pmxtjs's fetchOpenOrders sometimes throws "response.data is not
    // iterable" when wrapping a BadRequest response from the CLOB.
    // The reconcile path should swallow this as auth-gated so the
    // strategy cycle keeps running.
    mockFetchBalance.mockResolvedValueOnce([balance()]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockRejectedValueOnce(
      new Error("response.data is not iterable"),
    );

    const deps = createLivePositions();
    const portfolio = await deps.reconcile();
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });

  it("propagates non-auth fetchBalance errors", async () => {
    mockFetchBalance.mockRejectedValueOnce(new Error("network down"));
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    await expect(deps.reconcile()).rejects.toThrow("network down");
  });

  it("propagates client errors from fetchPositions", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance()]);
    mockFetchPositions.mockRejectedValueOnce(new Error("rate limited"));
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    await expect(deps.reconcile()).rejects.toThrow("rate limited");
  });
});

// ---------------------------------------------------------------------------
// getPortfolio
// ---------------------------------------------------------------------------

describe("createLivePositions.getPortfolio", () => {
  it("returns empty portfolio before first reconcile", () => {
    const deps = createLivePositions();
    const portfolio = deps.getPortfolio();

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });

  it("returns last reconciled snapshot", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance({ available: 100 })]);
    mockFetchPositions.mockResolvedValueOnce([
      clientPos({ size: 50, currentPrice: 0.50, unrealizedPnL: 5 }),
    ]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    const reconciled = await deps.reconcile();
    const snapshot = deps.getPortfolio();

    expect(snapshot).toEqual(reconciled);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.daily_pnl).toBeCloseTo(5);
  });

  it("updates snapshot on subsequent reconcile", async () => {
    mockFetchBalance.mockResolvedValueOnce([balance({ available: 100 })]);
    mockFetchPositions.mockResolvedValueOnce([clientPos({ size: 50 })]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    const deps = createLivePositions();
    await deps.reconcile();
    expect(deps.getPortfolio().positions).toHaveLength(1);

    mockFetchBalance.mockResolvedValueOnce([balance({ available: 200 })]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce([]);

    await deps.reconcile();
    const snapshot = deps.getPortfolio();
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.total_value).toBeCloseTo(200);
  });
});

// ---------------------------------------------------------------------------
// getOpenOrders
// ---------------------------------------------------------------------------

describe("createLivePositions.getOpenOrders", () => {
  it("exposes open orders fetched during reconcile", async () => {
    const orders = [
      openOrder({ id: "ord-1" }),
      openOrder({ id: "ord-2", marketId: "0xdef" }),
    ];
    mockFetchBalance.mockResolvedValueOnce([balance()]);
    mockFetchPositions.mockResolvedValueOnce([]);
    mockFetchOpenOrders.mockResolvedValueOnce(orders);

    const deps = createLivePositions();
    await deps.reconcile();

    const stored = deps.getOpenOrders();
    expect(stored).toHaveLength(2);
    expect(stored[0]!.id).toBe("ord-1");
    expect(stored[1]!.id).toBe("ord-2");
  });

  it("returns empty array before first reconcile", () => {
    const deps = createLivePositions();
    expect(deps.getOpenOrders()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No-wallet short-circuit (dry-run path)
// ---------------------------------------------------------------------------

describe("createLivePositions.reconcile (no wallet)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env["WALLET_PRIVATE_KEY"];
    delete process.env["POLYMARKET_PRIVATE_KEY"];
    const mod = await import("../live-positions.js");
    createLivePositions = mod.createLivePositions;
  });

  it("returns empty portfolio without calling the SDK", async () => {
    const deps = createLivePositions();
    const portfolio = await deps.reconcile();
    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
    expect(mockFetchBalance).not.toHaveBeenCalled();
    expect(mockFetchPositions).not.toHaveBeenCalled();
    expect(mockFetchOpenOrders).not.toHaveBeenCalled();
  });

  it("does not throw even when SDK would reject with non-auth phrasing", async () => {
    mockFetchOpenOrders.mockRejectedValue(
      new Error("response.data is not iterable"),
    );
    const deps = createLivePositions();
    await expect(deps.reconcile()).resolves.toBeDefined();
    expect(mockFetchOpenOrders).not.toHaveBeenCalled();
  });
});
