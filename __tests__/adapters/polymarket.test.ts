import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks for pmxtjs and sidecar — must be set before importing adapter.
// ---------------------------------------------------------------------------
const mockFetchMarkets = vi.hoisted(() => vi.fn());
const mockFetchOrderBook = vi.hoisted(() => vi.fn());
const mockFetchPositions = vi.hoisted(() => vi.fn());
const mockFetchBalance = vi.hoisted(() => vi.fn());
const mockFetchMyTrades = vi.hoisted(() => vi.fn());
const mockFetchOpenOrders = vi.hoisted(() => vi.fn());
const mockCallSidecar = vi.hoisted(() => vi.fn());

vi.mock("pmxtjs", () => {
  class MockPolymarket {
    fetchMarkets = mockFetchMarkets;
    fetchOrderBook = mockFetchOrderBook;
    fetchPositions = mockFetchPositions;
    fetchBalance = mockFetchBalance;
    fetchMyTrades = mockFetchMyTrades;
    fetchOpenOrders = mockFetchOpenOrders;
  }
  return { Polymarket: MockPolymarket };
});

vi.mock("../../sidecar.js", () => ({
  callSidecar: mockCallSidecar,
}));

import type { MarketClient, OrderParams } from "../../client-market.js";

let adapter: MarketClient;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env["POLYMARKET_PRIVATE_KEY"] = "0xtest";
  const mod = await import("../../adapters/polymarket.js");
  adapter = new mod.PolymarketAdapter();
});

afterEach(() => {
  delete process.env["POLYMARKET_PRIVATE_KEY"];
});

// ---------------------------------------------------------------------------
// searchMarkets — type mapping (conditionId → marketId, tokenIds → outcomeIds)
// ---------------------------------------------------------------------------
describe("PolymarketAdapter.searchMarkets", () => {
  it("maps pmxtjs market shape to venue-neutral MarketMatch", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "cond-abc",
        title: "Will the Lakers win?",
        outcomes: [
          { price: 0.55, outcomeId: "token-yes" },
          { price: 0.45, outcomeId: "token-no" },
        ],
        resolutionDate: new Date("2026-06-01"),
      },
    ]);

    const results = await adapter.searchMarkets("NBA");

    expect(results).toHaveLength(1);
    const match = results[0];
    expect(match?.marketId).toBe("cond-abc");
    expect(match?.question).toBe("Will the Lakers win?");
    expect(match?.yesPrice).toBe(0.55);
    expect(match?.noPrice).toBe(0.45);
    // Token ids are exposed under venue-neutral outcomeId names.
    expect(match?.yesOutcomeId).toBe("token-yes");
    expect(match?.noOutcomeId).toBe("token-no");
    expect(match?.resolutionDate).toBe("2026-06-01T00:00:00.000Z");
    // Adapter must NOT leak Polymarket-native field names.
    expect(match).not.toHaveProperty("conditionId");
    expect(match).not.toHaveProperty("yesTokenId");
    expect(match).not.toHaveProperty("noTokenId");
  });

  it("filters out non-binary markets", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "m-bin",
        title: "Binary",
        outcomes: [
          { price: 0.6, outcomeId: "y" },
          { price: 0.4, outcomeId: "n" },
        ],
      },
      {
        marketId: "m-tri",
        title: "Ternary",
        outcomes: [
          { price: 0.3, outcomeId: "a" },
          { price: 0.3, outcomeId: "b" },
          { price: 0.4, outcomeId: "c" },
        ],
      },
    ]);

    const results = await adapter.searchMarkets("test");
    expect(results).toHaveLength(1);
    expect(results[0]?.marketId).toBe("m-bin");
  });

  it("filters out markets missing outcome prices", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "m-ok",
        title: "OK",
        outcomes: [
          { price: 0.5, outcomeId: "y" },
          { price: 0.5, outcomeId: "n" },
        ],
      },
      {
        marketId: "m-bad",
        title: "Bad",
        outcomes: [
          { outcomeId: "y" },
          { price: 0.5, outcomeId: "n" },
        ],
      },
    ]);

    const results = await adapter.searchMarkets("test");
    expect(results).toHaveLength(1);
    expect(results[0]?.marketId).toBe("m-ok");
  });

  it("omits resolutionDate when not provided", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "m-no-date",
        title: "No date",
        outcomes: [
          { price: 0.5, outcomeId: "y" },
          { price: 0.5, outcomeId: "n" },
        ],
      },
    ]);

    const results = await adapter.searchMarkets("test");
    expect(results).toHaveLength(1);
    expect(results[0]).not.toHaveProperty("resolutionDate");
  });
});

// ---------------------------------------------------------------------------
// fetchMarketPrice — venue-neutral MarketPrice shape, prices in 0–1
// ---------------------------------------------------------------------------
describe("PolymarketAdapter.fetchMarketPrice", () => {
  it("returns MarketPrice with marketId/yesPrice/noPrice in 0–1", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "cond-abc",
        outcomes: [
          { price: 0.65, outcomeId: "y" },
          { price: 0.35, outcomeId: "n" },
        ],
      },
    ]);

    const price = await adapter.fetchMarketPrice("some-slug");

    expect(price.marketId).toBe("cond-abc");
    expect(price.yesPrice).toBe(0.65);
    expect(price.noPrice).toBe(0.35);
    // Prices are normalized to 0–1.
    expect(price.yesPrice).toBeGreaterThanOrEqual(0);
    expect(price.yesPrice).toBeLessThanOrEqual(1);
    expect(price.noPrice).toBeGreaterThanOrEqual(0);
    expect(price.noPrice).toBeLessThanOrEqual(1);
    expect(price.timestamp).toBeInstanceOf(Date);
    // Adapter must NOT leak Polymarket-native field names.
    expect(price).not.toHaveProperty("conditionId");
  });

  it("throws when market is not found", async () => {
    mockFetchMarkets.mockResolvedValueOnce([]);
    mockFetchMarkets.mockResolvedValueOnce([]);
    await expect(adapter.fetchMarketPrice("missing")).rejects.toThrow(
      /not found/,
    );
  });

  it("throws when market has non-binary outcomes", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "cond-xyz",
        outcomes: [
          { price: 0.3, outcomeId: "a" },
          { price: 0.3, outcomeId: "b" },
          { price: 0.4, outcomeId: "c" },
        ],
      },
    ]);
    await expect(adapter.fetchMarketPrice("cond-xyz")).rejects.toThrow(
      /binary/,
    );
  });

  it("throws when outcome prices are missing", async () => {
    mockFetchMarkets.mockResolvedValueOnce([
      {
        marketId: "cond-bad",
        outcomes: [{ outcomeId: "a" }, { outcomeId: "b" }],
      },
    ]);
    await expect(adapter.fetchMarketPrice("cond-bad")).rejects.toThrow(
      /price/,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchOrderBook — bids/asks mapped to PriceLevel[]
// ---------------------------------------------------------------------------
describe("PolymarketAdapter.fetchOrderBook", () => {
  it("returns mapped order book for a token", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      bids: [
        { price: 0.55, size: 100 },
        { price: 0.5, size: 200 },
      ],
      asks: [{ price: 0.6, size: 150 }],
    });

    const book = await adapter.fetchOrderBook("token-123");

    expect(book.outcomeId).toBe("token-123");
    expect(book.bids).toEqual([
      { price: 0.55, size: 100 },
      { price: 0.5, size: 200 },
    ]);
    expect(book.asks).toEqual([{ price: 0.6, size: 150 }]);
    expect(mockCallSidecar).toHaveBeenCalledWith("fetchOrderBook", [
      "token-123",
    ]);
  });

  it("strips extra fields from price levels", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      bids: [{ price: 0.5, size: 10, extra: "ignored" }],
      asks: [{ price: 0.6, size: 20, timestamp: 12345 }],
    });

    const book = await adapter.fetchOrderBook("token-x");
    expect(book.bids[0]).toEqual({ price: 0.5, size: 10 });
    expect(book.asks[0]).toEqual({ price: 0.6, size: 20 });
  });
});

// ---------------------------------------------------------------------------
// fetchPositions / fetchBalance — venue-neutral pass-through
// ---------------------------------------------------------------------------
describe("PolymarketAdapter.fetchPositions", () => {
  it("maps pmxtjs positions to shared Position[] using marketId/outcomeId", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      {
        marketId: "m-1",
        outcomeId: "o-1",
        outcomeLabel: "Yes",
        size: 10,
        entryPrice: 0.5,
        currentPrice: 0.6,
        unrealizedPnL: 1,
      },
    ]);

    const positions = await adapter.fetchPositions();
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p?.marketId).toBe("m-1");
    expect(p?.outcomeId).toBe("o-1");
    expect(p?.size).toBe(10);
    expect(p?.entryPrice).toBe(0.5);
    expect(p?.currentPrice).toBe(0.6);
    expect(p?.unrealizedPnL).toBe(1);
  });
});

describe("PolymarketAdapter.fetchBalance", () => {
  it("returns Balance[] with currency/total/available/locked", async () => {
    mockFetchBalance.mockResolvedValueOnce([
      { currency: "USDC", total: 100, available: 80, locked: 20 },
    ]);

    const balances = await adapter.fetchBalance();
    expect(balances).toHaveLength(1);
    expect(balances[0]).toEqual({
      currency: "USDC",
      total: 100,
      available: 80,
      locked: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// Sidecar-backed methods — fetchOHLCV / watchOrderBook / watchTrades
// ---------------------------------------------------------------------------
describe("PolymarketAdapter sidecar methods", () => {
  it("fetchOHLCV calls callSidecar with tokenId and resolution", async () => {
    const candles = [
      { timestamp: 1, open: 0.5, high: 0.6, low: 0.4, close: 0.55, volume: 10 },
    ];
    mockCallSidecar.mockResolvedValueOnce(candles);

    const result = await adapter.fetchOHLCV("token-1", { timeframe: "1h" });
    expect(result).toEqual(candles);
    expect(mockCallSidecar).toHaveBeenCalledWith(
      "fetchOHLCV",
      ["token-1", { resolution: "1h" }],
    );
  });

  it("fetchOHLCV defaults to 1h resolution when no timeframe given", async () => {
    mockCallSidecar.mockResolvedValueOnce([]);
    await adapter.fetchOHLCV("token-1");
    expect(mockCallSidecar).toHaveBeenCalledWith(
      "fetchOHLCV",
      ["token-1", { resolution: "1h" }],
    );
  });

  it("watchOrderBook proxies to sidecar", async () => {
    const snap = { bids: [], asks: [], timestamp: null };
    mockCallSidecar.mockResolvedValueOnce(snap);
    const result = await adapter.watchOrderBook("token-1");
    expect(result).toEqual({ outcomeId: "token-1", ...snap });
    expect(mockCallSidecar).toHaveBeenCalledWith("watchOrderBook", ["token-1"]);
  });

  it("watchTrades proxies to sidecar", async () => {
    const trades = [
      { id: "t1", price: 0.5, size: 1, side: "buy", timestamp: 100 },
    ];
    mockCallSidecar.mockResolvedValueOnce(trades);
    const result = await adapter.watchTrades("token-1");
    expect(result).toEqual(trades);
    expect(mockCallSidecar).toHaveBeenCalledWith("watchTrades", ["token-1"]);
  });
});

// ---------------------------------------------------------------------------
// Order param validation (price 0–1, size > 0, side/type enums)
// ---------------------------------------------------------------------------
function validParams(overrides?: Partial<OrderParams>): OrderParams {
  return {
    marketId: "m-1",
    outcomeId: "t-1",
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "limit",
    ...overrides,
  };
}

describe("PolymarketAdapter order validation", () => {
  it("createOrder rejects price < 0", async () => {
    await expect(
      adapter.createOrder(validParams({ price: -0.1 })),
    ).rejects.toThrow(/between 0 and 1/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it("createOrder rejects price > 1", async () => {
    await expect(
      adapter.createOrder(validParams({ price: 1.5 })),
    ).rejects.toThrow(/between 0 and 1/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it("createOrder rejects size <= 0", async () => {
    await expect(
      adapter.createOrder(validParams({ size: 0 })),
    ).rejects.toThrow(/greater than 0/);
    await expect(
      adapter.createOrder(validParams({ size: -5 })),
    ).rejects.toThrow(/greater than 0/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it("createOrder rejects invalid side", async () => {
    await expect(
      adapter.createOrder(
        validParams({ side: "hold" as unknown as OrderParams["side"] }),
      ),
    ).rejects.toThrow(/buy.*sell/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it("createOrder rejects invalid orderType", async () => {
    await expect(
      adapter.createOrder(
        validParams({
          orderType: "stop" as unknown as OrderParams["orderType"],
        }),
      ),
    ).rejects.toThrow(/market.*limit/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });

  it("buildOrder applies the same validation as createOrder", async () => {
    await expect(
      adapter.buildOrder(validParams({ price: 2 })),
    ).rejects.toThrow(/between 0 and 1/);
    await expect(
      adapter.buildOrder(validParams({ size: 0 })),
    ).rejects.toThrow(/greater than 0/);
    expect(mockCallSidecar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Order lifecycle — createOrder / cancelOrder / buildOrder happy paths
// ---------------------------------------------------------------------------
describe("PolymarketAdapter.createOrder", () => {
  it("returns OrderResponse with venue-neutral fields after sidecar call", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      id: "order-1",
      marketId: "m-1",
      outcomeId: "t-1",
      side: "buy",
      type: "limit",
      amount: 10,
      price: 0.5,
      status: "open",
      filled: 0,
      remaining: 10,
    });

    const result = await adapter.createOrder(validParams());
    expect(result.id).toBe("order-1");
    expect(result.marketId).toBe("m-1");
    expect(result.outcomeId).toBe("t-1");
    expect(result.side).toBe("buy");
    expect(result.type).toBe("limit");
    expect(result.amount).toBe(10);
    expect(result.price).toBe(0.5);
    expect(result.status).toBe("open");
    expect(result.filled).toBe(0);
    expect(result.remaining).toBe(10);
  });

  it("falls back to params.price when sidecar omits price", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      id: "order-2",
      marketId: "m-1",
      outcomeId: "t-1",
      side: "buy",
      type: "limit",
      amount: 10,
      status: "open",
      filled: 0,
      remaining: 10,
    });

    const result = await adapter.createOrder(validParams({ price: 0.42 }));
    expect(result.price).toBe(0.42);
  });
});

describe("PolymarketAdapter.cancelOrder", () => {
  it("returns CancelResult from sidecar response", async () => {
    mockCallSidecar.mockResolvedValueOnce({ id: "order-1", status: "cancelled" });
    const result = await adapter.cancelOrder("order-1");
    expect(result).toEqual({ id: "order-1", status: "cancelled" });
    expect(mockCallSidecar).toHaveBeenCalledWith(
      "cancelOrder",
      ["order-1"],
      expect.objectContaining({ privateKey: "0xtest" }),
    );
  });

  it("defaults id and status when sidecar response is sparse", async () => {
    mockCallSidecar.mockResolvedValueOnce({});
    const result = await adapter.cancelOrder("order-2");
    expect(result.id).toBe("order-2");
    expect(result.status).toBe("cancelled");
  });
});

describe("PolymarketAdapter.buildOrder", () => {
  it("returns BuildOrderResult with venue-neutral params", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      exchange: "polymarket",
      params: {
        marketId: "m-1",
        outcomeId: "t-1",
        side: "buy",
        type: "limit",
        amount: 10,
        price: 0.5,
      },
      signedOrder: { sig: "0xdead" },
      raw: { native: true },
    });

    const result = await adapter.buildOrder(validParams());
    expect(result.exchange).toBe("polymarket");
    expect(result.params.marketId).toBe("m-1");
    expect(result.params.outcomeId).toBe("t-1");
    expect(result.params.amount).toBe(10);
    expect(result.params.price).toBe(0.5);
    expect(result.signedOrder).toEqual({ sig: "0xdead" });
    expect(result.raw).toEqual({ native: true });
  });
});
