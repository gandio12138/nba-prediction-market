import { describe, it, expect, vi } from "vitest";
import type { OrderBook } from "../../../client-polymarket.js";
import { scanMarkets } from "../scan.js";
import type { ScanDeps, ScanSearchResult } from "../scan.js";
import type { ArbBinaryConfig } from "../signal.js";

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<ArbBinaryConfig>,
): ArbBinaryConfig {
  return {
    category: "NBA",
    feeRate: 0.02,
    gasCost: 0.02,
    hurdleRate: 0.015,
    slippageAbort: 0.003,
    bankroll: 10_000,
    kellyFraction: 0.25,
    maxExposure: 0.08,
    signalTtlMs: 5_000,
    ...overrides,
  };
}

function makeSearchResult(
  overrides?: Partial<ScanSearchResult>,
): ScanSearchResult {
  return {
    conditionId: "cond-001",
    question: "Will the Lakers win?",
    yesTokenId: "tok-yes-001",
    noTokenId: "tok-no-001",
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

/**
 * Build scan deps with hardcoded mock data.
 *
 * searchMarkets always resolves with the provided markets array.
 * fetchOrderBook resolves with the matching book from the record,
 * falling back to an empty book when the token ID is unknown.
 */
function makeDeps(
  markets: ScanSearchResult[],
  books: Record<string, OrderBook>,
): ScanDeps {
  return {
    searchMarkets: vi.fn(
      async (_query: string) => markets,
    ),
    fetchOrderBook: vi.fn(
      async (tokenId: string): Promise<OrderBook> =>
        books[tokenId] ?? { tokenId, asks: [], bids: [] },
    ),
  };
}

// ---------------------------------------------------------------------------
// Market fetching
// ---------------------------------------------------------------------------

describe("scanMarkets", () => {
  it("calls searchMarkets with the config category", async () => {
    const deps = makeDeps([], {});
    await scanMarkets(makeConfig({ category: "NBA" }), deps);

    expect(deps.searchMarkets).toHaveBeenCalledOnce();
    expect(deps.searchMarkets).toHaveBeenCalledWith("NBA");
  });

  it("uses the configured category for search query", async () => {
    const deps = makeDeps([], {});
    await scanMarkets(
      makeConfig({ category: "crypto" }),
      deps,
    );

    expect(deps.searchMarkets).toHaveBeenCalledWith("crypto");
  });

  it("fetches order book for both YES and NO token IDs", async () => {
    const market = makeSearchResult({
      yesTokenId: "tok-yes-XYZ",
      noTokenId: "tok-no-XYZ",
    });
    const books: Record<string, OrderBook> = {
      "tok-yes-XYZ": makeOrderBook(
        "tok-yes-XYZ",
        [{ price: 0.40, size: 300 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-no-XYZ": makeOrderBook(
        "tok-no-XYZ",
        [{ price: 0.40, size: 200 }],
        [{ price: 0.39, size: 400 }],
      ),
    };
    const deps = makeDeps([market], books);
    await scanMarkets(makeConfig(), deps);

    expect(deps.fetchOrderBook).toHaveBeenCalledWith(
      "tok-yes-XYZ",
    );
    expect(deps.fetchOrderBook).toHaveBeenCalledWith(
      "tok-no-XYZ",
    );
  });

  // -----------------------------------------------------------------------
  // Orderbook transformation to signal input format
  // -----------------------------------------------------------------------

  it("transforms order books into MarketData format", async () => {
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-yes-001": makeOrderBook(
        "tok-yes-001",
        [{ price: 0.40, size: 300 }],
        [{ price: 0.399, size: 500 }],
      ),
      "tok-no-001": makeOrderBook(
        "tok-no-001",
        [{ price: 0.40, size: 200 }],
        [{ price: 0.398, size: 400 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(1);
    const m = result[0]!;
    expect(m.conditionId).toBe("cond-001");
    expect(m.question).toBe("Will the Lakers win?");
    expect(m.yesAsk).toBe(0.40);
    expect(m.noAsk).toBe(0.40);
    expect(m.yesTokenId).toBe("tok-yes-001");
    expect(m.noTokenId).toBe("tok-no-001");
    expect(m.category).toBe("NBA");
    expect(m.estimatedSlippage).toBeGreaterThan(0);
    expect(m.estimatedSlippage).toBeLessThan(1);
  });

  it("extracts best ask (lowest price) from asks", async () => {
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-yes-001": makeOrderBook(
        "tok-yes-001",
        [
          { price: 0.50, size: 100 },
          { price: 0.42, size: 300 },
          { price: 0.55, size: 50 },
        ],
        [{ price: 0.38, size: 500 }],
      ),
      "tok-no-001": makeOrderBook(
        "tok-no-001",
        [
          { price: 0.45, size: 200 },
          { price: 0.38, size: 150 },
        ],
        [{ price: 0.35, size: 400 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result[0]!.yesAsk).toBe(0.42);
    expect(result[0]!.noAsk).toBe(0.38);
  });

  it("estimates slippage from bid-ask spread", async () => {
    // YES: bestAsk=0.50, bestBid=0.45
    //   spreadFrac = (0.50 - 0.45) / 0.50 = 0.10
    // NO:  bestAsk=0.40, bestBid=0.38
    //   spreadFrac = (0.40 - 0.38) / 0.40 = 0.05
    // estimatedSlippage = max(0.10, 0.05) = 0.10
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-yes-001": makeOrderBook(
        "tok-yes-001",
        [{ price: 0.50, size: 100 }],
        [{ price: 0.45, size: 200 }],
      ),
      "tok-no-001": makeOrderBook(
        "tok-no-001",
        [{ price: 0.40, size: 150 }],
        [{ price: 0.38, size: 300 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result[0]!.estimatedSlippage).toBeCloseTo(0.10, 4);
  });

  it("sets category from config on each MarketData", async () => {
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-yes-001": makeOrderBook(
        "tok-yes-001",
        [{ price: 0.40, size: 300 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-no-001": makeOrderBook(
        "tok-no-001",
        [{ price: 0.40, size: 200 }],
        [{ price: 0.39, size: 400 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(
      makeConfig({ category: "crypto" }),
      deps,
    );

    expect(result[0]!.category).toBe("crypto");
  });

  it("processes multiple markets independently", async () => {
    const marketA = makeSearchResult({
      conditionId: "cond-A",
      question: "Market A",
      yesTokenId: "tok-yes-A",
      noTokenId: "tok-no-A",
    });
    const marketB = makeSearchResult({
      conditionId: "cond-B",
      question: "Market B",
      yesTokenId: "tok-yes-B",
      noTokenId: "tok-no-B",
    });
    const books: Record<string, OrderBook> = {
      "tok-yes-A": makeOrderBook(
        "tok-yes-A",
        [{ price: 0.40, size: 300 }],
        [{ price: 0.39, size: 500 }],
      ),
      "tok-no-A": makeOrderBook(
        "tok-no-A",
        [{ price: 0.42, size: 200 }],
        [{ price: 0.41, size: 400 }],
      ),
      "tok-yes-B": makeOrderBook(
        "tok-yes-B",
        [{ price: 0.55, size: 100 }],
        [{ price: 0.53, size: 300 }],
      ),
      "tok-no-B": makeOrderBook(
        "tok-no-B",
        [{ price: 0.30, size: 250 }],
        [{ price: 0.28, size: 350 }],
      ),
    };
    const deps = makeDeps([marketA, marketB], books);
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(2);

    const a = result.find((m) => m.conditionId === "cond-A");
    const b = result.find((m) => m.conditionId === "cond-B");

    expect(a).toBeDefined();
    expect(a!.yesAsk).toBe(0.40);
    expect(a!.noAsk).toBe(0.42);
    expect(b).toBeDefined();
    expect(b!.yesAsk).toBe(0.55);
    expect(b!.noAsk).toBe(0.30);
  });

  it("returns empty array when search finds no markets", async () => {
    const deps = makeDeps([], {});
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toEqual([]);
    expect(deps.fetchOrderBook).not.toHaveBeenCalled();
  });

  it("skips market when fetchOrderBook throws and still returns others", async () => {
    const marketA = makeSearchResult({
      conditionId: "cond-A",
      question: "Market A",
      yesTokenId: "tok-yes-A",
      noTokenId: "tok-no-A",
    });
    const marketB = makeSearchResult({
      conditionId: "cond-B",
      question: "Market B",
      yesTokenId: "tok-yes-B",
      noTokenId: "tok-no-B",
    });
    const books: Record<string, OrderBook> = {
      "tok-yes-B": makeOrderBook(
        "tok-yes-B",
        [{ price: 0.55, size: 100 }],
        [{ price: 0.53, size: 300 }],
      ),
      "tok-no-B": makeOrderBook(
        "tok-no-B",
        [{ price: 0.30, size: 250 }],
        [{ price: 0.28, size: 350 }],
      ),
    };
    const deps: ScanDeps = {
      searchMarkets: vi.fn(
        async (_query: string) => [marketA, marketB],
      ),
      fetchOrderBook: vi.fn(
        async (tokenId: string): Promise<OrderBook> => {
          if (tokenId === "tok-yes-A" || tokenId === "tok-no-A") {
            throw new Error("boom");
          }
          return (
            books[tokenId] ?? { tokenId, asks: [], bids: [] }
          );
        },
      ),
    };
    const result = await scanMarkets(makeConfig(), deps);

    expect(result).toHaveLength(1);
    expect(result[0]!.conditionId).toBe("cond-B");
  });

  it("skips market when order book has no asks", async () => {
    const market = makeSearchResult();
    const books: Record<string, OrderBook> = {
      "tok-yes-001": makeOrderBook("tok-yes-001", [], []),
      "tok-no-001": makeOrderBook(
        "tok-no-001",
        [{ price: 0.40, size: 200 }],
        [{ price: 0.39, size: 400 }],
      ),
    };
    const deps = makeDeps([market], books);
    const result = await scanMarkets(makeConfig(), deps);

    // Market skipped — can't determine YES ask price
    expect(result).toHaveLength(0);
  });
});
