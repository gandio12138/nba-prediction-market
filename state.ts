/**
 * Local JSON state persistence for the trading pipeline.
 *
 * Tracks open orders, positions, and strategy state across agent
 * restarts. Uses atomic writes (write-to-temp then rename) to prevent
 * corruption on crash. The reconcile function merges local state with
 * live Polymarket positions from the API.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Position as ClientPosition } from "./client-polymarket.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrackedOrder {
  id: string;
  marketId: string;
  tokenId: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  status: "open" | "partial" | "filled" | "cancelled";
  filledSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedPosition {
  marketId: string;
  outcomeId: string;
  outcomeLabel: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
}

export interface StrategyState {
  lastPollAt: string | null;
  isRunning: boolean;
  signalsProcessed: number;
}

export interface PipelineState {
  orders: TrackedOrder[];
  positions: TrackedPosition[];
  strategy: StrategyState;
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a fresh empty pipeline state with current timestamp. */
export function createEmptyState(): PipelineState {
  return {
    orders: [],
    positions: [],
    strategy: {
      lastPollAt: null,
      isRunning: false,
      signalsProcessed: 0,
    },
    lastUpdated: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read pipeline state from a JSON file.
 *
 * Returns an empty state when the file is missing, empty, or contains
 * invalid JSON (corruption recovery).
 */
export async function readState(path: string): Promise<PipelineState> {
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.length === 0) {
      return createEmptyState();
    }
    return JSON.parse(raw) as PipelineState;
  } catch {
    return createEmptyState();
  }
}

/**
 * Write pipeline state to a JSON file atomically.
 *
 * Writes to a temporary `.tmp` file first, then renames to the target
 * path. This prevents corruption if the process crashes mid-write.
 * Creates parent directories if they do not exist.
 */
export async function writeState(
  path: string,
  state: PipelineState,
): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Reconcile local positions with live API data.
 *
 * API positions are the source of truth. The reconciled state:
 * - Adds positions present in the API but not locally
 * - Updates positions that exist in both (API values win)
 * - Removes positions absent from the API response
 * - Preserves orders and strategy state unchanged
 *
 * This is a pure function — it returns a new state without mutating
 * the input.
 */
export function reconcilePositions(
  state: PipelineState,
  apiPositions: ClientPosition[],
): PipelineState {
  const positions: TrackedPosition[] = apiPositions.map((p) => ({
    marketId: p.marketId,
    outcomeId: p.outcomeId,
    outcomeLabel: p.outcomeLabel,
    size: p.size,
    entryPrice: p.entryPrice,
    currentPrice: p.currentPrice,
    unrealizedPnL: p.unrealizedPnL,
  }));

  return {
    orders: state.orders,
    strategy: state.strategy,
    positions,
    lastUpdated: new Date().toISOString(),
  };
}
