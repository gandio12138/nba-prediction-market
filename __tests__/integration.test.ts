import { describe, it, expect, beforeAll } from "vitest";
import { Polymarket } from "pmxtjs";
import {
  fetchMarketPrice,
  searchMarkets,
  fetchOrderBook,
  fetchOHLCV,
} from "../client-polymarket.js";

/**
 * Integration tests for read-only Polymarket client methods.
 *
 * Hit the real Polymarket API — no mocks, no auth required.
 * Requires network access and the pmxt sidecar (auto-started by SDK).
 */
// SKIP: pmxt-core ≥2.37 paginates fetchMarkets({limit:N}) (no query) up
// to ~1.25M rows, which never returns. Once a query is supplied the
// path is fast. Re-enable when pmxt-core stops pre-paginating without a
// search term, or rewrite this fixture to pass a query.
describe.skip("integration: read-only", () => {
  let tokenId = "";
  let conditionId = "";

  beforeAll(async () => {
    const poly = new Polymarket({ autoStartServer: true });
    const markets = await poly.fetchMarkets({ limit: 20 });
    const sorted = [...markets].sort(
      (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0),
    );

    for (const m of sorted) {
      const outcome = m.outcomes[0];
      if (m.outcomes.length === 2 && outcome?.outcomeId) {
        tokenId = outcome.outcomeId;
        conditionId = m.marketId;
        break;
      }
    }

    if (!tokenId || !conditionId) {
      throw new Error(
        "Setup failed: no binary market with outcomeId found",
      );
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // searchMarkets
  // -------------------------------------------------------------------------
  describe("searchMarkets", () => {
    it("returns binary markets matching a query", async () => {
      const results = await searchMarkets("NBA");

      expect(results.length).toBeGreaterThan(0);

      const first = results[0];
      expect(first).toBeDefined();
      expect(first?.conditionId).toBeTruthy();
      expect(first?.question).toBeTruthy();
      expect(first?.yesPrice).toBeGreaterThanOrEqual(0);
      expect(first?.yesPrice).toBeLessThanOrEqual(1);
      expect(first?.noPrice).toBeGreaterThanOrEqual(0);
      expect(first?.noPrice).toBeLessThanOrEqual(1);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // fetchMarketPrice
  // -------------------------------------------------------------------------
  describe("fetchMarketPrice", () => {
    it("returns a price snapshot for a real market", async () => {
      const price = await fetchMarketPrice(conditionId);

      expect(price.conditionId).toBeTruthy();
      expect(price.yes).toBeGreaterThanOrEqual(0);
      expect(price.yes).toBeLessThanOrEqual(1);
      expect(price.no).toBeGreaterThanOrEqual(0);
      expect(price.no).toBeLessThanOrEqual(1);
      expect(price.timestamp).toBeInstanceOf(Date);
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // fetchOrderBook
  // -------------------------------------------------------------------------
  describe("fetchOrderBook", () => {
    // Skipped: hardcoded `tokenId` references a market that has resolved on
    // Polymarket; the sidecar now returns 404 ORDER_NOT_FOUND. Refresh the
    // fixture (or query the sidecar for an active token at test start) before
    // un-skipping.
    it.skip("returns bids and asks for a real token", async () => {
      const book = await fetchOrderBook(tokenId);

      expect(book.tokenId).toBe(tokenId);
      expect(Array.isArray(book.bids)).toBe(true);
      expect(Array.isArray(book.asks)).toBe(true);
      expect(book.bids.length + book.asks.length).toBeGreaterThan(0);

      const topBid = book.bids[0];
      if (topBid) {
        expect(topBid.price).toBeGreaterThan(0);
        expect(topBid.price).toBeLessThanOrEqual(1);
        expect(topBid.size).toBeGreaterThan(0);
      }

      const topAsk = book.asks[0];
      if (topAsk) {
        expect(topAsk.price).toBeGreaterThan(0);
        expect(topAsk.price).toBeLessThanOrEqual(1);
        expect(topAsk.size).toBeGreaterThan(0);
      }
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // fetchOHLCV
  // -------------------------------------------------------------------------
  describe("fetchOHLCV", () => {
    it("returns candle data for a real token", async () => {
      const candles = await fetchOHLCV(tokenId);

      expect(Array.isArray(candles)).toBe(true);
      expect(candles.length).toBeGreaterThan(0);

      const first = candles[0];
      expect(first).toBeDefined();
      expect(first?.timestamp).toEqual(expect.any(Number));
      expect(first?.open).toEqual(expect.any(Number));
      expect(first?.high).toEqual(expect.any(Number));
      expect(first?.low).toEqual(expect.any(Number));
      expect(first?.close).toEqual(expect.any(Number));
      // high must be >= low within any candle
      expect(first!.high).toBeGreaterThanOrEqual(first!.low);
    }, 30_000);
  });
});
