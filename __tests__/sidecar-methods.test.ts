import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCallSidecar = vi.hoisted(() => vi.fn());

vi.mock("../sidecar.js", () => ({
  callSidecar: mockCallSidecar,
}));

vi.mock("pmxtjs", () => ({
  Polymarket: class {},
}));

import type {
  fetchOHLCV as FetchOHLCVFn,
  watchOrderBook as WatchOrderBookFn,
  watchTrades as WatchTradesFn,
} from "../client-polymarket.js";

let fetchOHLCV: typeof FetchOHLCVFn;
let watchOrderBook: typeof WatchOrderBookFn;
let watchTrades: typeof WatchTradesFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../client-polymarket.js");
  fetchOHLCV = mod.fetchOHLCV;
  watchOrderBook = mod.watchOrderBook;
  watchTrades = mod.watchTrades;
});

// ---------------------------------------------------------------------------
// fetchOHLCV
// ---------------------------------------------------------------------------
describe("fetchOHLCV", () => {
  it("calls callSidecar with tokenId and returns candle data", async () => {
    const candles = [
      {
        timestamp: 1700000000000,
        open: 0.45,
        high: 0.55,
        low: 0.4,
        close: 0.5,
        volume: 1000,
      },
      {
        timestamp: 1700003600000,
        open: 0.5,
        high: 0.6,
        low: 0.48,
        close: 0.58,
        volume: null,
      },
    ];
    mockCallSidecar.mockResolvedValueOnce(candles);

    const result = await fetchOHLCV("token-123");

    expect(mockCallSidecar).toHaveBeenCalledWith(
      "fetchOHLCV",
      ["token-123", { resolution: "1h" }],
    );
    expect(result).toEqual(candles);
    expect(result).toHaveLength(2);
    expect(result[0]?.volume).toBe(1000);
    expect(result[1]?.volume).toBeNull();
  });

  it("forwards timeframe as resolution to callSidecar args", async () => {
    mockCallSidecar.mockResolvedValueOnce([]);

    await fetchOHLCV("token-456", { timeframe: "5m" });

    expect(mockCallSidecar).toHaveBeenCalledWith(
      "fetchOHLCV",
      ["token-456", { resolution: "5m" }],
    );
  });

  it("returns empty array when no candles are available", async () => {
    mockCallSidecar.mockResolvedValueOnce([]);

    const result = await fetchOHLCV("token-empty");

    expect(result).toEqual([]);
  });

  it("propagates sidecar-not-running error", async () => {
    const err = Object.assign(new Error("sidecar not running"), {
      name: "SidecarNotRunningError",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(fetchOHLCV("token-123")).rejects.toBe(err);
  });

  it("propagates sidecar request error on 401", async () => {
    const err = Object.assign(new Error("Unauthorized"), {
      name: "SidecarRequestError",
      status: 401,
      method: "fetchOHLCV",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(fetchOHLCV("token-123")).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// watchOrderBook
// ---------------------------------------------------------------------------
describe("watchOrderBook", () => {
  it("calls callSidecar with tokenId and returns order book", async () => {
    const book = {
      bids: [
        { price: 0.55, size: 100 },
        { price: 0.5, size: 200 },
      ],
      asks: [{ price: 0.6, size: 150 }],
      timestamp: 1700000000000,
    };
    mockCallSidecar.mockResolvedValueOnce(book);

    const result = await watchOrderBook("outcome-abc");

    expect(mockCallSidecar).toHaveBeenCalledWith(
      "watchOrderBook",
      ["outcome-abc"],
    );
    expect(result.bids).toHaveLength(2);
    expect(result.asks).toHaveLength(1);
    expect(result.bids[0]?.price).toBe(0.55);
    expect(result.timestamp).toBe(1700000000000);
  });

  it("handles empty order book with null timestamp", async () => {
    mockCallSidecar.mockResolvedValueOnce({
      bids: [],
      asks: [],
      timestamp: null,
    });

    const result = await watchOrderBook("outcome-empty");

    expect(result.bids).toEqual([]);
    expect(result.asks).toEqual([]);
    expect(result.timestamp).toBeNull();
  });

  it("propagates sidecar-not-running error", async () => {
    const err = Object.assign(new Error("sidecar not running"), {
      name: "SidecarNotRunningError",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(watchOrderBook("outcome-abc")).rejects.toBe(err);
  });

  it("propagates sidecar request error on 500", async () => {
    const err = Object.assign(new Error("Internal Server Error"), {
      name: "SidecarRequestError",
      status: 500,
      method: "watchOrderBook",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(watchOrderBook("outcome-abc")).rejects.toBe(err);
  });
});

// ---------------------------------------------------------------------------
// watchTrades
// ---------------------------------------------------------------------------
describe("watchTrades", () => {
  it("calls callSidecar with tokenId and returns trades", async () => {
    const trades = [
      {
        id: "t-1",
        price: 0.55,
        size: 50,
        side: "buy",
        timestamp: 1700000000,
      },
      {
        id: "t-2",
        price: 0.54,
        size: 30,
        side: "sell",
        timestamp: 1700000001,
      },
    ];
    mockCallSidecar.mockResolvedValueOnce(trades);

    const result = await watchTrades("outcome-xyz");

    expect(mockCallSidecar).toHaveBeenCalledWith(
      "watchTrades",
      ["outcome-xyz"],
    );
    expect(result).toEqual(trades);
    expect(result).toHaveLength(2);
    expect(result[0]?.side).toBe("buy");
  });

  it("returns empty array when no trades occurred", async () => {
    mockCallSidecar.mockResolvedValueOnce([]);

    const result = await watchTrades("outcome-quiet");

    expect(result).toEqual([]);
  });

  it("propagates sidecar-not-running error", async () => {
    const err = Object.assign(new Error("sidecar not running"), {
      name: "SidecarNotRunningError",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(watchTrades("outcome-xyz")).rejects.toBe(err);
  });

  it("propagates sidecar request error on 401", async () => {
    const err = Object.assign(new Error("Unauthorized"), {
      name: "SidecarRequestError",
      status: 401,
      method: "watchTrades",
    });
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(watchTrades("outcome-xyz")).rejects.toBe(err);
  });

  it("propagates network errors from fetch", async () => {
    const err = new TypeError("fetch failed");
    mockCallSidecar.mockRejectedValueOnce(err);

    await expect(watchTrades("outcome-xyz")).rejects.toBe(err);
  });
});
