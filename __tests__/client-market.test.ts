import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MarketClient } from "../client-market.js";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------
// The factory under test should construct `PolymarketAdapter` on demand.
// We mock the adapter module so each test gets a fresh `vi.fn()`-stubbed
// instance whose constructor calls we can count (for caching assertions).

const adapterCtor = vi.fn();

function makeStubAdapter(): MarketClient {
  return {
    searchMarkets: vi.fn(),
    fetchMarketSnapshots: vi.fn(),
    searchMultiOutcomeMarkets: vi.fn(),
    fetchMarketPrice: vi.fn(),
    fetchOrderBook: vi.fn(),
    fetchOHLCV: vi.fn(),
    fetchPositions: vi.fn(),
    fetchBalance: vi.fn(),
    fetchMyTrades: vi.fn(),
    fetchOpenOrders: vi.fn(),
    createOrder: vi.fn(),
    cancelOrder: vi.fn(),
    buildOrder: vi.fn(),
    watchOrderBook: vi.fn(),
    watchTrades: vi.fn(),
    getCapabilities: vi.fn(),
    ensureAccount: vi.fn(),
  };
}

vi.mock("../adapters/polymarket.js", () => {
  class MockPolymarketAdapter {
    constructor() {
      adapterCtor();
      Object.assign(this, makeStubAdapter());
    }
  }
  return { PolymarketAdapter: MockPolymarketAdapter };
});

let getMarketClient: typeof import("../client-market.js").getMarketClient;

const originalEnv = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // Strip MARKET_VENUE between tests so each one starts clean.
  delete process.env["MARKET_VENUE"];
  const mod = await import("../client-market.js");
  getMarketClient = mod.getMarketClient;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// Interface contract
// ---------------------------------------------------------------------------
describe("MarketClient interface contract", () => {
  it("exposes every required method on the returned client", () => {
    const client = getMarketClient("polymarket");

    const required: Array<keyof MarketClient> = [
      "searchMarkets",
      "fetchMarketSnapshots",
      "searchMultiOutcomeMarkets",
      "fetchMarketPrice",
      "fetchOrderBook",
      "fetchOHLCV",
      "fetchPositions",
      "fetchBalance",
      "fetchMyTrades",
      "fetchOpenOrders",
      "createOrder",
      "cancelOrder",
      "buildOrder",
      "watchOrderBook",
      "watchTrades",
      "getCapabilities",
      "ensureAccount",
    ];

    for (const method of required) {
      expect(typeof client[method]).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Factory: venue selection
// ---------------------------------------------------------------------------
describe("getMarketClient — venue selection", () => {
  it("defaults to polymarket when no arg and no env var", () => {
    const client = getMarketClient();
    expect(client).toBeDefined();
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });

  it("uses MARKET_VENUE env var when no arg is passed", () => {
    process.env["MARKET_VENUE"] = "polymarket";
    const client = getMarketClient();
    expect(client).toBeDefined();
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });

  it("explicit arg wins over MARKET_VENUE env var", () => {
    process.env["MARKET_VENUE"] = "kalshi"; // would throw if read
    const client = getMarketClient("polymarket");
    expect(client).toBeDefined();
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });

  it("throws on an unknown venue", () => {
    expect(() => getMarketClient("nonexistent-venue")).toThrow(
      /nonexistent-venue/,
    );
  });

  it("throws when MARKET_VENUE selects an unknown venue", () => {
    process.env["MARKET_VENUE"] = "bogus";
    expect(() => getMarketClient()).toThrow(/bogus/);
  });
});

// ---------------------------------------------------------------------------
// Factory: caching
// ---------------------------------------------------------------------------
describe("getMarketClient — caching", () => {
  it("returns the same instance for repeated calls with the same venue", () => {
    const a = getMarketClient("polymarket");
    const b = getMarketClient("polymarket");
    expect(a).toBe(b);
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });

  it("default and explicit polymarket share the same cached instance", () => {
    const fromDefault = getMarketClient();
    const fromExplicit = getMarketClient("polymarket");
    expect(fromDefault).toBe(fromExplicit);
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });

  it("env-var-selected client is the same instance as explicit-arg client", () => {
    process.env["MARKET_VENUE"] = "polymarket";
    const fromEnv = getMarketClient();
    const fromArg = getMarketClient("polymarket");
    expect(fromEnv).toBe(fromArg);
    expect(adapterCtor).toHaveBeenCalledTimes(1);
  });
});
