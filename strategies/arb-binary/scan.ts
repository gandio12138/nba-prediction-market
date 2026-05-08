/**
 * ARB-01 Binary Arbitrage — Scan Layer
 *
 * Data fetching + transformation: calls searchMarkets and fetchOrderBook,
 * transforms results into MarketData format for signal detection.
 */

import type { MarketData, ArbBinaryConfig } from "./signal.js";
import type { OrderBook } from "../../client-polymarket.js";

/** Market from the search dependency — includes CLOB token IDs. */
export interface ScanSearchResult {
  /** Polymarket condition ID. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** CLOB token ID for the YES outcome. */
  yesTokenId: string;
  /** CLOB token ID for the NO outcome. */
  noTokenId: string;
}

/** Injectable dependencies for the scan layer. */
export interface ScanDeps {
  /** Search for binary markets by category query. */
  searchMarkets: (query: string) => Promise<ScanSearchResult[]>;
  /** Fetch order book for a CLOB token. */
  fetchOrderBook: (tokenId: string) => Promise<OrderBook>;
}

/**
 * Scan Polymarket for binary markets and transform to signal input.
 *
 * For each market returned by searchMarkets(config.category):
 * 1. Fetch YES and NO order books
 * 2. Extract best ask prices (lowest ask)
 * 3. Estimate slippage from bid-ask spread
 * 4. Return as MarketData for signal detection
 */
export async function scanMarkets(
  config: ArbBinaryConfig,
  deps: ScanDeps,
): Promise<MarketData[]> {
  const markets = await deps.searchMarkets(config.category);

  const results: MarketData[] = [];

  for (const market of markets) {
    if (!market.yesTokenId || !market.noTokenId) {
      continue;
    }

    let yesBook: OrderBook;
    let noBook: OrderBook;
    try {
      [yesBook, noBook] = await Promise.all([
        deps.fetchOrderBook(market.yesTokenId),
        deps.fetchOrderBook(market.noTokenId),
      ]);
    } catch {
      continue;
    }

    if (yesBook.asks.length === 0 || noBook.asks.length === 0) {
      continue;
    }

    const yesAsk = Math.min(
      ...yesBook.asks.map((a) => a.price),
    );
    const noAsk = Math.min(
      ...noBook.asks.map((a) => a.price),
    );

    const yesBid =
      yesBook.bids.length > 0
        ? Math.max(...yesBook.bids.map((b) => b.price))
        : 0;
    const noBid =
      noBook.bids.length > 0
        ? Math.max(...noBook.bids.map((b) => b.price))
        : 0;

    const yesSpread = (yesAsk - yesBid) / yesAsk;
    const noSpread = (noAsk - noBid) / noAsk;

    results.push({
      conditionId: market.conditionId,
      question: market.question,
      category: config.category,
      yesAsk,
      noAsk,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      estimatedSlippage: Math.max(yesSpread, noSpread),
    });
  }

  return results;
}
