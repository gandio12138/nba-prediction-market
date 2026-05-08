import { describe, it, expect, vi } from "vitest";
import type { OrderBook } from "../../../client-polymarket.js";
import { scanMarkets } from "../scan.js";
import type { ScanDeps, ScanSearchResult } from "../scan.js";
import type { NegRiskBuyConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<NegRiskBuyConfig>,
): NegRiskBuyConfig {
  return {
    category: "NBA Champion",
    feeRate: 0.02,
    gasPerLeg: 0.05,
    hurdleRate: 0.03,
    bankroll: 10_000,
    kellyFraction: 0.15,
    maxExposure: 0.05,
    signalTtlMs: 15_000,
    minLegLiquidity: 300,
    maxLegPriceWithLowLiq: 0.30,
    lowLiqThreshold: 100,
    sumThreshold: 0.97,
    ...overrides,
  };
}

function makeSearchResult(
  overrides?: Partial<ScanSearchResult>,
): ScanSearchResult {
  return {
    conditionId: "cond-neg-001",
    question: "Who wins the 2026 NBA Championship?",
    isNegRisk: true,
    legs: [
      { outcome: "Lakers", tokenId: "tok-lak" },
      { outcome: "Celtics", tokenId: "tok-cel" },
      { outcome: "Nuggets", tokenId: "tok-nug" },
    ],
    ...overrides,
  };
}

function makeOrderBook(
  tokenId: string,
  asks: Array<{ price: number; size: number }>,
  bids: Array<{ price: number; size: number }>,
): OrderBook {
  return { tokenId, asks, bids };
}

function makeDeps(
  markets: ScanSearchResult[],
  books: Record<string, OrderBook>,
): ScanDeps {
  return {
    searchMarkets: vi.fn(async (_query: string) => markets),
    fetchOrderBook: vi.fn(
      async (tokenId: string): Promise<OrderBook> =>
        books[tokenId] ?? { tokenId, asks: [], bids: [] },
    ),
  };
}

// ---------------------------------------------------------------------------
// NegRisk filter — non-NegRisk markets must be dropped
// ---------------------------------------------------------------------------

describe("scanMarkets — NegRisk filter", () => {
  it("calls searchMarkets with the config category", async () => {
    const deps = makeDeps([], {});
    await scanMarkets(makeConfig({ category: "NBA Champion" }), deps);

    expect(deps.searchMarkets).toHaveBeenCalledOnce();
    expect(deps.searchMarkets).toHaveBeenCalledWith("NBA Champion");
  });

  it("drops markets where isNegRisk is false", async () => {
    const negRisk = makeSearchResult({
      conditionId: "cond-negrisk",
      isNegRisk: true,
    });
    const binary = makeSearchResult({
      conditionId: "cond-binary",
      isNegRisk: false,
      legs: [
        { outcome: "YES", tokenId: "tok-bin-yes" },
        { outcome: "NO", tokenId: "tok-bin-no" },
      ],
    });
    const books: Record<string, OrderBook> = {
      "tok-lak": makeOrderBook(
        "tok-lak",
        [{ price: 0.40, size: 500 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-cel": makeOrderBook(
        "tok-cel",
        [{ price: 0.30, size: 500 }],
        [{ price: 0.29, size: 500 }],
      ),
      "tok-nug": makeOrderBook(
        "tok-nug",
        [{ price: 0.20, size: 500 }],
        [{ price: 0.19, size: 500 }],
      ),
    };
    const deps = makeDeps([negRisk, binary], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(1);
    expect(result[0]!.conditionId).toBe("cond-negrisk");
    // Binary market legs must never be fetched
    expect(deps.fetchOrderBook).not.toHaveBeenCalledWith("tok-bin-yes");
    expect(deps.fetchOrderBook).not.toHaveBeenCalledWith("tok-bin-no");
  });

  it("returns empty array when every market is non-NegRisk", async () => {
    const binary = makeSearchResult({ isNegRisk: false });
    const deps = makeDeps([binary], {});
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toEqual([]);
    expect(deps.fetchOrderBook).not.toHaveBeenCalled();
  });

  it("fetches order book for every leg of a NegRisk market", async () => {
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-lak": makeOrderBook(
        "tok-lak",
        [{ price: 0.40, size: 500 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-cel": makeOrderBook(
        "tok-cel",
        [{ price: 0.30, size: 500 }],
        [{ price: 0.29, size: 500 }],
      ),
      "tok-nug": makeOrderBook(
        "tok-nug",
        [{ price: 0.20, size: 500 }],
        [{ price: 0.19, size: 500 }],
      ),
    };
    const deps = makeDeps([market], books);
    await scanMarkets(makeConfig(), deps);

    expect(deps.fetchOrderBook).toHaveBeenCalledWith("tok-lak");
    expect(deps.fetchOrderBook).toHaveBeenCalledWith("tok-cel");
    expect(deps.fetchOrderBook).toHaveBeenCalledWith("tok-nug");
  });

  it("transforms legs into NegRiskLeg with yesAsk/yesBid/liquidity", async () => {
    const market = makeSearchResult({
      legs: [
        { outcome: "Lakers", tokenId: "tok-lak" },
        { outcome: "Celtics", tokenId: "tok-cel" },
      ],
    });
    const books: Record<string, OrderBook> = {
      "tok-lak": makeOrderBook(
        "tok-lak",
        [{ price: 0.55, size: 400 }],
        [{ price: 0.53, size: 600 }],
      ),
      "tok-cel": makeOrderBook(
        "tok-cel",
        [{ price: 0.46, size: 300 }],
        [{ price: 0.44, size: 500 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(1);
    const m = result[0]!;
    expect(m.conditionId).toBe("cond-neg-001");
    expect(m.legs).toHaveLength(2);

    const lakers = m.legs.find((l) => l.outcome === "Lakers");
    expect(lakers).toBeDefined();
    expect(lakers!.yesAsk).toBe(0.55);
    expect(lakers!.yesBid).toBe(0.53);
    expect(lakers!.tokenId).toBe("tok-lak");
    expect(lakers!.liquidity).toBeGreaterThan(0);

    const celtics = m.legs.find((l) => l.outcome === "Celtics");
    expect(celtics).toBeDefined();
    expect(celtics!.yesAsk).toBe(0.46);
    expect(celtics!.yesBid).toBe(0.44);
  });

  it("sets category from config on each NegRiskMarketData", async () => {
    const market = makeSearchResult({
      legs: [
        { outcome: "A", tokenId: "tok-a" },
        { outcome: "B", tokenId: "tok-b" },
      ],
    });
    const books: Record<string, OrderBook> = {
      "tok-a": makeOrderBook(
        "tok-a",
        [{ price: 0.40, size: 500 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-b": makeOrderBook(
        "tok-b",
        [{ price: 0.40, size: 500 }],
        [{ price: 0.39, size: 500 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(
      makeConfig({ category: "World Cup" }),
      deps,
    );

    expect(result[0]!.category).toBe("World Cup");
  });

  it("skips market when any leg has empty asks", async () => {
    const market = makeSearchResult({
      legs: [
        { outcome: "A", tokenId: "tok-a" },
        { outcome: "B", tokenId: "tok-b" },
      ],
    });
    const books: Record<string, OrderBook> = {
      "tok-a": makeOrderBook("tok-a", [], []),
      "tok-b": makeOrderBook(
        "tok-b",
        [{ price: 0.40, size: 500 }],
        [{ price: 0.39, size: 500 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(0);
  });

  it("returns empty array when search finds no markets", async () => {
    const deps = makeDeps([], {});
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toEqual([]);
    expect(deps.fetchOrderBook).not.toHaveBeenCalled();
  });
});
