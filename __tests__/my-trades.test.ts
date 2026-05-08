import { describe, it, expect, vi, beforeEach } from "vitest";
import type { fetchMyTrades as FetchMyTradesFn } from "../client-polymarket.js";

const mockFetchMyTrades = vi.fn();

vi.mock("pmxtjs", () => {
  class MockPolymarket {
    fetchMyTrades = mockFetchMyTrades;
  }
  return { Polymarket: MockPolymarket };
});

let fetchMyTrades: typeof FetchMyTradesFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../client-polymarket.js");
  fetchMyTrades = mod.fetchMyTrades;
});

// ---------------------------------------------------------------------------
// fetchMyTrades — trade shape
// ---------------------------------------------------------------------------
describe("fetchMyTrades", () => {
  it("returns typed trades with all fields on success", async () => {
    mockFetchMyTrades.mockResolvedValueOnce([
      {
        id: "trade-1",
        price: 0.65,
        amount: 100,
        side: "buy",
        timestamp: 1713000000000,
        orderId: "order-abc",
        outcomeId: "tok-1",
        marketId: "0xabc",
      },
      {
        id: "trade-2",
        price: 0.35,
        amount: 50,
        side: "sell",
        timestamp: 1713000060000,
        orderId: "order-def",
        outcomeId: "tok-2",
        marketId: "0xdef",
      },
    ]);

    const result = await fetchMyTrades();

    expect(result).toHaveLength(2);

    const t0 = result[0]!;
    expect(t0.id).toBe("trade-1");
    expect(t0.price).toBe(0.65);
    expect(t0.amount).toBe(100);
    expect(t0.side).toBe("buy");
    expect(t0.timestamp).toBe(1713000000000);
    expect(t0.orderId).toBe("order-abc");
    expect(t0.outcomeId).toBe("tok-1");
    expect(t0.marketId).toBe("0xabc");

    const t1 = result[1]!;
    expect(t1.id).toBe("trade-2");
    expect(t1.side).toBe("sell");
    expect(t1.amount).toBe(50);
  });

  it("returns trades with only required fields", async () => {
    mockFetchMyTrades.mockResolvedValueOnce([
      {
        id: "trade-min",
        price: 0.5,
        amount: 10,
        side: "unknown",
        timestamp: 1713000000000,
      },
    ]);

    const result = await fetchMyTrades();

    expect(result).toHaveLength(1);

    const t = result[0]!;
    expect(t.id).toBe("trade-min");
    expect(t.price).toBe(0.5);
    expect(t.amount).toBe(10);
    expect(t.side).toBe("unknown");
    expect(t.timestamp).toBe(1713000000000);
    expect(t.orderId).toBeUndefined();
    expect(t.outcomeId).toBeUndefined();
    expect(t.marketId).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // fetchMyTrades — empty history
  // ---------------------------------------------------------------------------
  it("returns empty array when no trades exist", async () => {
    mockFetchMyTrades.mockResolvedValueOnce([]);

    const result = await fetchMyTrades();

    expect(result).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // fetchMyTrades — pagination
  // ---------------------------------------------------------------------------
  it("passes params through to pmxtjs for filtering", async () => {
    mockFetchMyTrades.mockResolvedValueOnce([
      {
        id: "trade-filtered",
        price: 0.7,
        amount: 25,
        side: "buy",
        timestamp: 1713000120000,
      },
    ]);

    const params = { marketId: "0xabc", limit: 10 };
    await fetchMyTrades(params);

    expect(mockFetchMyTrades).toHaveBeenCalledWith(params);
  });

  it("passes cursor for pagination", async () => {
    mockFetchMyTrades.mockResolvedValueOnce([
      {
        id: "trade-page2",
        price: 0.4,
        amount: 15,
        side: "sell",
        timestamp: 1713000180000,
      },
    ]);

    const params = { cursor: "next-page-token", limit: 5 };
    await fetchMyTrades(params);

    expect(mockFetchMyTrades).toHaveBeenCalledWith(params);
  });

  // ---------------------------------------------------------------------------
  // fetchMyTrades — auth error
  // ---------------------------------------------------------------------------
  it("propagates auth error from pmxtjs", async () => {
    mockFetchMyTrades.mockRejectedValueOnce(
      new Error(
        "AuthenticationError: Trading operations require authentication. " +
          "Initialize PolymarketExchange with credentials: " +
          'new PolymarketExchange({ privateKey: "0x..." })',
      ),
    );

    await expect(fetchMyTrades()).rejects.toThrow("AuthenticationError");
  });
});
