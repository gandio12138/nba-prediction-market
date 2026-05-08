/**
 * Live position manager — wraps the Polymarket client to produce a
 * Portfolio snapshot consumable by the runner's RiskInterface.
 *
 * Reused by ARB-01 (live executor) and future MINT-01, MINT-05, ARB-02
 * strategies.
 */

import {
  fetchBalance,
  fetchOpenOrders,
  fetchPositions,
  type OrderResponse,
  type Position as ClientPosition,
} from "./client-polymarket.js";
import { getWalletPrivateKey } from "./env.js";
import type { Portfolio, Position } from "./types/RiskInterface.js";

export interface PositionDeps {
  reconcile(): Promise<Portfolio>;
  getPortfolio(): Portfolio;
  getOpenOrders(): OrderResponse[];
}

const LABEL_TO_DIRECTION: Record<string, Position["direction"]> = {
  Yes: "buy_yes",
  No: "buy_no",
};

function emptyPortfolio(): Portfolio {
  return { total_value: 0, positions: [], daily_pnl: 0 };
}

/**
 * Detect auth-gated SDK errors (e.g. "Trading operations require
 * authentication"). Used to keep dry-run reconcile graceful when no
 * wallet creds are present — `reconcile` returns an empty portfolio
 * instead of crashing the cycle.
 */
function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("authentication") ||
    msg.includes("unauthorized") ||
    msg.includes("credentials") ||
    // pmxtjs's fetchOpenOrders occasionally rejects with
    // "response.data is not iterable" (BadRequest wrapping a malformed
    // unauthed response). Treat as auth-gated so the cycle keeps
    // running instead of crashing on transient sidecar flakiness.
    msg.includes("is not iterable")
  );
}

let warnedNoCreds = false;

function mapPosition(p: ClientPosition): Position {
  return {
    market_id: p.marketId,
    direction: LABEL_TO_DIRECTION[p.outcomeLabel] ?? "buy_yes",
    size: p.size,
    entry_price: p.entryPrice,
    opened_at: new Date(),
  };
}

export function createLivePositions(): PositionDeps {
  let snapshot: Portfolio = emptyPortfolio();
  let openOrders: OrderResponse[] = [];

  async function reconcile(): Promise<Portfolio> {
    // Short-circuit when no wallet private key is configured. Without
    // creds, the SDK auth path can throw under several different error
    // phrasings (e.g. "Authentication failed", "response.data is not
    // iterable" from a malformed unauthed response) — string matching
    // against any of them is fragile. Detecting the missing wallet
    // upfront removes the entire class of error-phrasing surprises.
    if (!getWalletPrivateKey()) {
      if (!warnedNoCreds) {
        warnedNoCreds = true;
        process.stderr.write(
          "[canon] portfolio reconcile skipped: no wallet credentials " +
            "(dry-run mode). Set WALLET_PRIVATE_KEY for live portfolio.\n",
        );
      }
      snapshot = emptyPortfolio();
      openOrders = [];
      return snapshot;
    }

    let balances, clientPositions, orders;
    try {
      [balances, clientPositions, orders] = await Promise.all([
        fetchBalance(),
        fetchPositions(),
        fetchOpenOrders(),
      ]);
    } catch (err) {
      if (isAuthError(err)) {
        if (!warnedNoCreds) {
          warnedNoCreds = true;
          process.stderr.write(
            "[canon] portfolio reconcile skipped: no wallet credentials " +
              "(dry-run mode). Set WALLET_PRIVATE_KEY for live portfolio.\n",
          );
        }
        snapshot = emptyPortfolio();
        openOrders = [];
        return snapshot;
      }
      throw err;
    }

    const cash = balances
      .filter((b) => b.currency === "USDC")
      .reduce((acc, b) => acc + b.available, 0);

    const markValue = clientPositions.reduce(
      (acc, p) => acc + p.size * p.currentPrice,
      0,
    );

    const dailyPnl = clientPositions.reduce(
      (acc, p) => acc + p.unrealizedPnL,
      0,
    );

    snapshot = {
      positions: clientPositions.map(mapPosition),
      total_value: cash + markValue,
      daily_pnl: dailyPnl,
    };
    openOrders = orders;
    return snapshot;
  }

  return {
    reconcile,
    getPortfolio: () => snapshot,
    getOpenOrders: () => openOrders,
  };
}
