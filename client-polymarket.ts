/**
 * Backwards-compatible shim for the prediction-market client.
 *
 * Phase 1 of the venue-agnostic refactor: this module exposes the legacy
 * named-function API but delegates every market call to the venue-neutral
 * `MarketClient` returned by `getMarketClient()`. On-chain helpers are
 * re-exported from `./adapters/polymarket-onchain.js`.
 *
 * Phase 2 will migrate consumers to import directly from
 * `./client-market.js` and remove this shim.
 */

import { getMarketClient } from "./client-market.js";
import type {
  Balance,
  BuildOrderResult as MBuildOrderResult,
  Capabilities as MCapabilities,
  CancelResult as MCancelResult,
  FetchMyTradesParams as MFetchMyTradesParams,
  FetchOHLCVOptions as MFetchOHLCVOptions,
  MarketSnapshot,
  MultiOutcomeMatch as MMultiOutcomeMatch,
  OrderParams as MOrderParams,
  OrderResponse as MOrderResponse,
  OutcomeLeg as MOutcomeLeg,
  Position as MPosition,
  PriceCandle as MPriceCandle,
  PriceLevel as MPriceLevel,
  TimeInForce as MTimeInForce,
  Trade as MTrade,
  UserTrade as MUserTrade,
} from "./client-market.js";

// ---------------------------------------------------------------------------
// Legacy types (preserved for Phase 1 consumers)
// ---------------------------------------------------------------------------

/** YES/NO price snapshot for a Polymarket condition. */
export interface MarketPrice {
  conditionId: string;
  yes: number;
  no: number;
  timestamp: Date;
}

/** A Polymarket market search result. */
export interface PolymarketMatch {
  conditionId: string;
  question: string;
  yesPrice: number;
  noPrice: number;
  yesTokenId: string;
  noTokenId: string;
  resolutionDate?: string;
}

/** A single leg (outcome) of a multi-outcome Polymarket market. */
export interface MultiOutcomeLeg {
  outcome: string;
  /** CLOB token ID for this leg's YES outcome. */
  tokenId: string;
  yesPrice: number;
}

/** A multi-outcome (>2 outcomes) Polymarket market — NegRisk candidate. */
export interface MultiOutcomeMatch {
  conditionId: string;
  question: string;
  legs: MultiOutcomeLeg[];
}

/**
 * Snapshot of a binary market with the time-series fields strategies
 * like TRADE-02 momentum and IA-03 fair-value need.
 */
export interface BinaryMarketSnapshot {
  conditionId: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  volume24h: number;
  openInterest: number;
  /** Milliseconds until market close, or `undefined` when not surfaced. */
  timeToCloseMs?: number;
  /** Snapshot timestamp (ms since epoch). */
  timestampMs: number;
}

export type PriceLevel = MPriceLevel;

/** Order book for a single outcome token. */
export interface OrderBook {
  tokenId: string;
  bids: PriceLevel[];
  asks: PriceLevel[];
}

export type Position = MPosition;

/** Account balance entry for a Polymarket account. */
export type AccountBalance = Balance;

export type UserTrade = MUserTrade;
export type FetchMyTradesParams = MFetchMyTradesParams;
export type PriceCandle = MPriceCandle;
export type FetchOHLCVOptions = MFetchOHLCVOptions;

/** Order book snapshot from the pmxt sidecar. */
export interface SidecarOrderBook {
  bids: PriceLevel[];
  asks: PriceLevel[];
  timestamp: number | null;
}

export type Trade = MTrade;

/** Time-in-force semantics for limit orders. */
export type TimeInForce = MTimeInForce;

/** Parameters for creating or building an order. */
export interface OrderParams {
  marketId: string;
  tokenId: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  orderType: "market" | "limit";
  /** Optional time-in-force; only meaningful for `orderType === "limit"`. */
  timeInForce?: TimeInForce;
}

export type OrderResponse = MOrderResponse;
export type CancelResult = MCancelResult;
export type BuildOrderResult = MBuildOrderResult;

/** Feature flags advertised by the pmxt sidecar (Polymarket-specific re-export). */
export type SidecarCapabilities = MCapabilities;

// ---------------------------------------------------------------------------
// On-chain helpers (re-exported from the Polymarket-only adapter module)
// ---------------------------------------------------------------------------

export {
  fetchOnChainBalances,
  swapToUsdce,
} from "./adapters/polymarket-onchain.js";
export type {
  OnChainBalance,
  SwapResult,
  SwapSource,
} from "./adapters/polymarket-onchain.js";

// ---------------------------------------------------------------------------
// Market function shims — delegate to the default MarketClient instance.
// ---------------------------------------------------------------------------

function toMarketParams(p: OrderParams): MOrderParams {
  return {
    marketId: p.marketId,
    outcomeId: p.tokenId,
    side: p.side,
    size: p.size,
    price: p.price,
    orderType: p.orderType,
    ...(p.timeInForce !== undefined ? { timeInForce: p.timeInForce } : {}),
  };
}

function fromMarketSnapshot(s: MarketSnapshot): BinaryMarketSnapshot {
  return {
    conditionId: s.marketId,
    question: s.question,
    yesTokenId: s.yesOutcomeId,
    noTokenId: s.noOutcomeId,
    yesPrice: s.yesPrice,
    noPrice: s.noPrice,
    volume24h: s.volume24h,
    openInterest: s.openInterest,
    ...(s.timeToCloseMs !== undefined ? { timeToCloseMs: s.timeToCloseMs } : {}),
    timestampMs: s.timestampMs,
  };
}

function fromMultiOutcomeMatch(m: MMultiOutcomeMatch): MultiOutcomeMatch {
  return {
    conditionId: m.marketId,
    question: m.question,
    legs: m.legs.map(
      (l: MOutcomeLeg): MultiOutcomeLeg => ({
        outcome: l.outcome,
        tokenId: l.outcomeId,
        yesPrice: l.yesPrice,
      }),
    ),
  };
}

export async function fetchMarketPrice(
  conditionId: string,
): Promise<MarketPrice> {
  const r = await getMarketClient().fetchMarketPrice(conditionId);
  return {
    conditionId: r.marketId,
    yes: r.yesPrice,
    no: r.noPrice,
    timestamp: r.timestamp,
  };
}

export async function searchMarkets(
  query: string,
): Promise<PolymarketMatch[]> {
  const matches = await getMarketClient().searchMarkets(query);
  return matches.map((m) => ({
    conditionId: m.marketId,
    question: m.question,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    yesTokenId: m.yesOutcomeId,
    noTokenId: m.noOutcomeId,
    ...(m.resolutionDate !== undefined
      ? { resolutionDate: m.resolutionDate }
      : {}),
  }));
}

export async function fetchBinaryMarketSnapshots(
  query: string,
): Promise<BinaryMarketSnapshot[]> {
  const snaps = await getMarketClient().fetchMarketSnapshots(query);
  return snaps.map(fromMarketSnapshot);
}

export async function searchMultiOutcomeMarkets(
  query: string,
): Promise<MultiOutcomeMatch[]> {
  const matches = await getMarketClient().searchMultiOutcomeMarkets(query);
  return matches.map(fromMultiOutcomeMatch);
}

export async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
  const book = await getMarketClient().fetchOrderBook(tokenId);
  return {
    tokenId,
    bids: book.bids,
    asks: book.asks,
  };
}

export async function fetchPositions(): Promise<Position[]> {
  return getMarketClient().fetchPositions();
}

export async function fetchBalance(): Promise<AccountBalance[]> {
  return getMarketClient().fetchBalance();
}

export async function fetchMyTrades(
  params?: FetchMyTradesParams,
): Promise<UserTrade[]> {
  return getMarketClient().fetchMyTrades(params);
}

export async function fetchOpenOrders(
  marketId?: string,
): Promise<OrderResponse[]> {
  return getMarketClient().fetchOpenOrders(marketId);
}

export async function createOrder(
  params: OrderParams,
): Promise<OrderResponse> {
  return getMarketClient().createOrder(toMarketParams(params));
}

export async function cancelOrder(orderId: string): Promise<CancelResult> {
  return getMarketClient().cancelOrder(orderId);
}

export async function buildOrder(
  params: OrderParams,
): Promise<BuildOrderResult> {
  return getMarketClient().buildOrder(toMarketParams(params));
}

export async function fetchOHLCV(
  tokenId: string,
  options?: FetchOHLCVOptions,
): Promise<PriceCandle[]> {
  return getMarketClient().fetchOHLCV(tokenId, options);
}

export async function watchOrderBook(
  tokenId: string,
): Promise<SidecarOrderBook> {
  const book = await getMarketClient().watchOrderBook(tokenId);
  return {
    bids: book.bids,
    asks: book.asks,
    timestamp: book.timestamp ?? null,
  };
}

export async function watchTrades(tokenId: string): Promise<Trade[]> {
  return getMarketClient().watchTrades(tokenId);
}

/**
 * Query the running pmxt sidecar for advertised feature flags.
 *
 * Used by `--live` start-up gates to refuse to run when the sidecar
 * cannot honour required semantics (e.g. FOK time-in-force).
 */
export async function getCapabilities(): Promise<SidecarCapabilities> {
  return getMarketClient().getCapabilities();
}

/**
 * Auto-discover and persist `WALLET_PROXY_ADDRESS` for live trading.
 *
 * Returns the resolved Safe proxy address (or `undefined` when the
 * wallet is not migrated / not on Polymarket yet) so callers can log
 * + smoke-test. Idempotent.
 */
export async function ensurePolymarketProxy(): Promise<string | undefined> {
  const result = await getMarketClient().ensureAccount();
  return result.accountId;
}
