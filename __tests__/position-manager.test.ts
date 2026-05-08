import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Position, Portfolio } from "../types/RiskInterface.js";
import type { Position as ClientPosition } from "../client-polymarket.js";

// ---------------------------------------------------------------------------
// Types expected from position-manager (TDD API contract)
// ---------------------------------------------------------------------------

type Direction = Position["direction"];

/** Closed position for realized P&L calculation. */
interface ClosedPosition {
  market_id: string;
  direction: Direction;
  size: number;
  entry_price: number;
  exit_price: number;
  closed_at: Date;
}

/** Result of reconciling local state with Polymarket API positions. */
interface ReconciliationResult {
  /** Positions found in both local state and API. */
  matched: Position[];
  /** Positions in local state but not on the API (closed externally). */
  orphaned: Position[];
  /** Positions on the API but not in local state (opened externally). */
  untracked: ClientPosition[];
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFetchPositions = vi.fn();

vi.mock("../client-polymarket.js", () => ({
  fetchPositions: mockFetchPositions,
}));

// ---------------------------------------------------------------------------
// Module under test — dynamically imported after mock setup
// ---------------------------------------------------------------------------

let calculateUnrealizedPnL: (
  direction: Direction,
  entryPrice: number,
  currentPrice: number,
  size: number,
) => number;

let calculateRealizedPnL: (closedPositions: ClosedPosition[]) => number;

let calculateDailyPnL: (unrealized: number, realized: number) => number;

let aggregatePortfolio: (positions: ClientPosition[]) => Portfolio;

let fetchPortfolio: () => Promise<Portfolio>;

let reconcile: (
  localPositions: Position[],
  apiPositions: ClientPosition[],
) => ReconciliationResult;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../position-manager.js");
  calculateUnrealizedPnL = mod.calculateUnrealizedPnL;
  calculateRealizedPnL = mod.calculateRealizedPnL;
  calculateDailyPnL = mod.calculateDailyPnL;
  aggregatePortfolio = mod.aggregatePortfolio;
  fetchPortfolio = mod.fetchPortfolio;
  reconcile = mod.reconcile;
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

function localPos(overrides?: Partial<Position>): Position {
  return {
    market_id: "0xabc",
    direction: "buy_yes",
    size: 100,
    entry_price: 0.45,
    opened_at: new Date("2026-04-14T08:00:00Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// calculateUnrealizedPnL
// ---------------------------------------------------------------------------
describe("calculateUnrealizedPnL", () => {
  it("returns positive P&L for buy_yes when price rises", () => {
    // (0.60 - 0.40) * 100 = 20
    const pnl = calculateUnrealizedPnL("buy_yes", 0.40, 0.60, 100);
    expect(pnl).toBeCloseTo(20);
  });

  it("returns negative P&L for buy_yes when price drops", () => {
    // (0.40 - 0.60) * 100 = -20
    const pnl = calculateUnrealizedPnL("buy_yes", 0.60, 0.40, 100);
    expect(pnl).toBeCloseTo(-20);
  });

  it("returns positive P&L for sell_yes when price drops", () => {
    // sell: (entry - current) * size = (0.60 - 0.40) * 100 = 20
    const pnl = calculateUnrealizedPnL("sell_yes", 0.60, 0.40, 100);
    expect(pnl).toBeCloseTo(20);
  });

  it("returns positive P&L for buy_no when price rises", () => {
    // (0.50 - 0.30) * 50 = 10
    const pnl = calculateUnrealizedPnL("buy_no", 0.30, 0.50, 50);
    expect(pnl).toBeCloseTo(10);
  });

  it("returns 0 for zero-size position", () => {
    const pnl = calculateUnrealizedPnL("buy_yes", 0.50, 0.70, 0);
    expect(pnl).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateRealizedPnL
// ---------------------------------------------------------------------------
describe("calculateRealizedPnL", () => {
  it("calculates profit from a single closed buy position", () => {
    // (0.70 - 0.40) * 100 = 30
    const pnl = calculateRealizedPnL([
      {
        market_id: "0xabc",
        direction: "buy_yes",
        size: 100,
        entry_price: 0.40,
        exit_price: 0.70,
        closed_at: new Date("2026-04-14T10:00:00Z"),
      },
    ]);
    expect(pnl).toBeCloseTo(30);
  });

  it("handles mix of profit and loss across positions", () => {
    const pnl = calculateRealizedPnL([
      {
        market_id: "0xabc",
        direction: "buy_yes",
        size: 100,
        entry_price: 0.40,
        exit_price: 0.70,
        closed_at: new Date("2026-04-14T10:00:00Z"),
      },
      {
        market_id: "0xdef",
        direction: "buy_yes",
        size: 50,
        entry_price: 0.60,
        exit_price: 0.45,
        closed_at: new Date("2026-04-14T11:00:00Z"),
      },
    ]);
    // (0.70 - 0.40) * 100 + (0.45 - 0.60) * 50 = 30 + (-7.5) = 22.5
    expect(pnl).toBeCloseTo(22.5);
  });

  it("returns 0 for empty array", () => {
    expect(calculateRealizedPnL([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// calculateDailyPnL
// ---------------------------------------------------------------------------
describe("calculateDailyPnL", () => {
  it("sums unrealized and realized P&L", () => {
    expect(calculateDailyPnL(15, 10)).toBe(25);
  });

  it("handles negative unrealized with positive realized", () => {
    expect(calculateDailyPnL(-5, 10)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// aggregatePortfolio
// ---------------------------------------------------------------------------
describe("aggregatePortfolio", () => {
  it("builds Portfolio from multiple client positions", () => {
    const positions = [
      clientPos({ marketId: "0xabc", entryPrice: 0.45, size: 100, unrealizedPnL: 10 }),
      clientPos({ marketId: "0xdef", entryPrice: 0.60, size: 50, unrealizedPnL: -5 }),
    ];

    const portfolio: Portfolio = aggregatePortfolio(positions);

    expect(portfolio.positions).toHaveLength(2);
    expect(portfolio.total_value).toBe(150);
    expect(portfolio.daily_pnl).toBeCloseTo(5);

    const pos0 = portfolio.positions[0]!;
    expect(pos0.market_id).toBe("0xabc");
    expect(pos0.entry_price).toBe(0.45);
    expect(pos0.size).toBe(100);
  });

  it("maps outcomeLabel Yes to buy_yes direction", () => {
    const portfolio = aggregatePortfolio([
      clientPos({ outcomeLabel: "Yes" }),
    ]);
    expect(portfolio.positions[0]!.direction).toBe("buy_yes");
  });

  it("maps outcomeLabel No to buy_no direction", () => {
    const portfolio = aggregatePortfolio([
      clientPos({ outcomeLabel: "No" }),
    ]);
    expect(portfolio.positions[0]!.direction).toBe("buy_no");
  });

  it("returns empty portfolio for no positions", () => {
    const portfolio = aggregatePortfolio([]);

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fetchPortfolio
// ---------------------------------------------------------------------------
describe("fetchPortfolio", () => {
  it("fetches from client and returns Portfolio snapshot", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      clientPos({ marketId: "0xabc", size: 100, unrealizedPnL: 10 }),
    ]);

    const portfolio = await fetchPortfolio();

    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.total_value).toBe(100);
    expect(portfolio.daily_pnl).toBeCloseTo(10);
    expect(mockFetchPositions).toHaveBeenCalledOnce();
  });

  it("returns empty portfolio when no positions exist", async () => {
    mockFetchPositions.mockResolvedValueOnce([]);

    const portfolio = await fetchPortfolio();

    expect(portfolio.positions).toEqual([]);
    expect(portfolio.total_value).toBe(0);
    expect(portfolio.daily_pnl).toBe(0);
  });

  it("propagates client auth error", async () => {
    mockFetchPositions.mockRejectedValueOnce(
      new Error("AuthenticationError: credentials required"),
    );

    await expect(fetchPortfolio()).rejects.toThrow(
      "AuthenticationError",
    );
  });
});

// ---------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------
describe("reconcile", () => {
  it("matches positions by market_id", () => {
    const local = [localPos({ market_id: "0xabc" })];
    const api = [clientPos({ marketId: "0xabc" })];

    const result: ReconciliationResult = reconcile(local, api);

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.market_id).toBe("0xabc");
    expect(result.orphaned).toHaveLength(0);
    expect(result.untracked).toHaveLength(0);
  });

  it("identifies orphaned local positions not on API", () => {
    const local = [
      localPos({ market_id: "0xabc" }),
      localPos({ market_id: "0xghi" }),
    ];
    const api = [clientPos({ marketId: "0xabc" })];

    const result = reconcile(local, api);

    expect(result.matched).toHaveLength(1);
    expect(result.orphaned).toHaveLength(1);
    expect(result.orphaned[0]!.market_id).toBe("0xghi");
  });

  it("identifies untracked API positions not in local state", () => {
    const local = [localPos({ market_id: "0xabc" })];
    const api = [
      clientPos({ marketId: "0xabc" }),
      clientPos({ marketId: "0xnew" }),
    ];

    const result = reconcile(local, api);

    expect(result.matched).toHaveLength(1);
    expect(result.untracked).toHaveLength(1);
    expect(result.untracked[0]!.marketId).toBe("0xnew");
  });

  it("all API positions untracked when local state is empty", () => {
    const api = [
      clientPos({ marketId: "0xabc" }),
      clientPos({ marketId: "0xdef" }),
    ];

    const result = reconcile([], api);

    expect(result.matched).toHaveLength(0);
    expect(result.orphaned).toHaveLength(0);
    expect(result.untracked).toHaveLength(2);
  });

  it("all local positions orphaned when API returns empty", () => {
    const local = [
      localPos({ market_id: "0xabc" }),
      localPos({ market_id: "0xdef" }),
    ];

    const result = reconcile(local, []);

    expect(result.matched).toHaveLength(0);
    expect(result.orphaned).toHaveLength(2);
    expect(result.untracked).toHaveLength(0);
  });
});
