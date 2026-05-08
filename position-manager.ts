/**
 * Position manager — fetch from Polymarket API, calculate P&L,
 * update local state, expose Portfolio snapshot.
 */

import type { Position, Portfolio } from "./types/RiskInterface.js";
import type { Position as ClientPosition } from "./client-polymarket.js";
import { fetchPositions } from "./client-polymarket.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Direction = Position["direction"];

/** Closed position for realized P&L calculation. */
export interface ClosedPosition {
  market_id: string;
  direction: Direction;
  size: number;
  entry_price: number;
  exit_price: number;
  closed_at: Date;
}

/** Result of reconciling local state with Polymarket API positions. */
export interface ReconciliationResult {
  /** Positions found in both local state and API. */
  matched: Position[];
  /** Positions in local state but not on the API (closed externally). */
  orphaned: Position[];
  /** Positions on the API but not in local state (opened externally). */
  untracked: ClientPosition[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUY_DIRECTIONS: ReadonlySet<Direction> = new Set([
  "buy_yes",
  "buy_no",
]);

const LABEL_TO_DIRECTION: Record<string, Direction> = {
  Yes: "buy_yes",
  No: "buy_no",
};

// ---------------------------------------------------------------------------
// P&L calculations
// ---------------------------------------------------------------------------

/**
 * Calculate unrealized P&L for a single open position.
 *
 * Buy directions: (currentPrice - entryPrice) * size
 * Sell directions: (entryPrice - currentPrice) * size
 */
export function calculateUnrealizedPnL(
  direction: Direction,
  entryPrice: number,
  currentPrice: number,
  size: number,
): number {
  if (BUY_DIRECTIONS.has(direction)) {
    return (currentPrice - entryPrice) * size;
  }
  return (entryPrice - currentPrice) * size;
}

/**
 * Calculate total realized P&L across closed positions.
 *
 * Same directional logic as unrealized — buy profits when exit > entry,
 * sell profits when entry > exit.
 */
export function calculateRealizedPnL(
  closedPositions: ClosedPosition[],
): number {
  let total = 0;
  for (const pos of closedPositions) {
    if (BUY_DIRECTIONS.has(pos.direction)) {
      total += (pos.exit_price - pos.entry_price) * pos.size;
    } else {
      total += (pos.entry_price - pos.exit_price) * pos.size;
    }
  }
  return total;
}

/** Sum unrealized and realized P&L for the current day. */
export function calculateDailyPnL(
  unrealized: number,
  realized: number,
): number {
  return unrealized + realized;
}

// ---------------------------------------------------------------------------
// Portfolio aggregation
// ---------------------------------------------------------------------------

/**
 * Build a Portfolio snapshot from Polymarket client positions.
 *
 * Maps outcomeLabel "Yes" → buy_yes, "No" → buy_no.
 * total_value = sum of position sizes.
 * daily_pnl = sum of unrealizedPnL across all positions.
 */
export function aggregatePortfolio(
  positions: ClientPosition[],
): Portfolio {
  let totalValue = 0;
  let dailyPnl = 0;
  const mapped: Position[] = [];

  for (const p of positions) {
    totalValue += p.size;
    dailyPnl += p.unrealizedPnL;
    mapped.push({
      market_id: p.marketId,
      direction: LABEL_TO_DIRECTION[p.outcomeLabel] ?? "buy_yes",
      size: p.size,
      entry_price: p.entryPrice,
      opened_at: new Date(),
    });
  }

  return {
    total_value: totalValue,
    positions: mapped,
    daily_pnl: dailyPnl,
  };
}

/**
 * Fetch positions from Polymarket and return a Portfolio snapshot.
 *
 * Delegates to fetchPositions from client-polymarket, then aggregates.
 * Auth errors propagate to the caller.
 */
export async function fetchPortfolio(): Promise<Portfolio> {
  const positions = await fetchPositions();
  return aggregatePortfolio(positions);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile local positions with Polymarket API positions.
 *
 * Compares by market_id (local) vs marketId (API):
 * - matched: positions present in both local and API
 * - orphaned: positions in local state but absent from API
 * - untracked: positions on API but not in local state
 */
export function reconcile(
  localPositions: Position[],
  apiPositions: ClientPosition[],
): ReconciliationResult {
  const apiMarketIds = new Set(apiPositions.map((p) => p.marketId));
  const localMarketIds = new Set(
    localPositions.map((p) => p.market_id),
  );

  const matched: Position[] = [];
  const orphaned: Position[] = [];

  for (const local of localPositions) {
    if (apiMarketIds.has(local.market_id)) {
      matched.push(local);
    } else {
      orphaned.push(local);
    }
  }

  const untracked: ClientPosition[] = apiPositions.filter(
    (p) => !localMarketIds.has(p.marketId),
  );

  return { matched, orphaned, untracked };
}
