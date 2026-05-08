/**
 * ARB-03 NegRisk Multi-condition Buy — Scan Layer
 *
 * Data fetching + transformation: calls searchMarkets and fetchOrderBook,
 * drops non-NegRisk markets, and transforms each NegRisk market into a
 * NegRiskMarketData snapshot for signal evaluation.
 */

import type { OrderBook } from "../../client-polymarket.js";
import type { NegRiskBuyConfig } from "./config.js";
import type { NegRiskLeg, NegRiskMarket } from "./signal.js";

/** A candidate leg from the search dependency — CLOB token + label only. */
export interface ScanSearchLeg {
  /** Human-readable outcome label (e.g. "Lakers"). */
  outcome: string;
  /** CLOB token ID for this leg's YES outcome. */
  tokenId: string;
}

/** Market from the search dependency — includes NegRisk flag + legs. */
export interface ScanSearchResult {
  /** Polymarket condition ID for the parent event. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** True when the parent market is flagged `neg_risk`. */
  isNegRisk: boolean;
  /** Candidate legs (N outcomes). */
  legs: ScanSearchLeg[];
}

/** Injectable dependencies for the scan layer. */
export interface ScanDeps {
  /** Search for NegRisk-capable markets by category query. */
  searchMarkets: (query: string) => Promise<ScanSearchResult[]>;
  /** Fetch order book for a CLOB token. */
  fetchOrderBook: (tokenId: string) => Promise<OrderBook>;
}

/** A scanned leg with top-of-book ask + bid + liquidity. */
export interface NegRiskMarketDataLeg extends NegRiskLeg {
  /** Best YES ask price (lowest ask). */
  yesAsk: number;
}

/** Scanner output — structurally compatible with `NegRiskMarket`. */
export interface NegRiskMarketData extends Omit<NegRiskMarket, "legs"> {
  /** Scanned legs (carry top-of-book ask + bid + USD liquidity). */
  legs: NegRiskMarketDataLeg[];
}

function topAsk(book: OrderBook): { price: number; size: number } | null {
  if (book.asks.length === 0) return null;
  let best = book.asks[0]!;
  for (const level of book.asks) {
    if (level.price < best.price) best = level;
  }
  return best;
}

function topBid(book: OrderBook): { price: number; size: number } | null {
  if (book.bids.length === 0) return null;
  let best = book.bids[0]!;
  for (const level of book.bids) {
    if (level.price > best.price) best = level;
  }
  return best;
}

/**
 * Scan Polymarket for NegRisk markets and transform to signal input.
 *
 * For each market returned by `searchMarkets(config.category)`:
 * 1. Drop if `isNegRisk === false` (never fetch its books).
 * 2. Fetch order book for every leg.
 * 3. Skip market if any leg has empty asks (dead leg).
 * 4. Emit a `NegRiskMarketData` snapshot with per-leg yesAsk/yesBid/liquidity.
 */
export async function scanMarkets(
  config: NegRiskBuyConfig,
  deps: ScanDeps,
): Promise<NegRiskMarketData[]> {
  const markets = await deps.searchMarkets(config.category);

  const results: NegRiskMarketData[] = [];

  for (const market of markets) {
    if (!market.isNegRisk) continue;

    const books = await Promise.all(
      market.legs.map((leg) => deps.fetchOrderBook(leg.tokenId)),
    );

    let skip = false;
    const legs: NegRiskMarketDataLeg[] = [];

    for (let i = 0; i < market.legs.length; i++) {
      const leg = market.legs[i]!;
      const book = books[i]!;
      const ask = topAsk(book);
      if (ask === null) {
        skip = true;
        break;
      }
      const bid = topBid(book);
      const yesAsk = ask.price;
      const yesBid = bid !== null ? bid.price : 0;
      const liquidity =
        ask.price * ask.size + (bid !== null ? bid.price * bid.size : 0);

      legs.push({
        outcome: leg.outcome,
        tokenId: leg.tokenId,
        yesAsk,
        yesBid,
        liquidity,
      });
    }

    if (skip) continue;

    results.push({
      conditionId: market.conditionId,
      question: market.question,
      category: config.category,
      isNegRisk: true,
      legs,
    });
  }

  return results;
}
