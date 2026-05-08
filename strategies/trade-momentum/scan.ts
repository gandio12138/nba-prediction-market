/**
 * TRADE-02 Momentum Trading — Scan Layer
 *
 * Polls prediction-market snapshots, maintains a per-market rolling
 * history (capped at `config.historyCap`), prunes entries older than
 * `config.signalTtlMs`, and drops markets whose `timeToCloseMs` is below
 * the 24h hard-floor cutoff.
 *
 * Confluence, entry-band, and manipulation guards belong to `signal.ts`;
 * this layer is deliberately narrow so the signal evaluator receives a
 * full `{snapshot, history}` context per viable market.
 */

import type { TradeMomentumConfig } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;

/** One prediction-market snapshot at a single poll cycle. */
export interface TradeMomentumSnapshot {
  /** Platform market identifier (Polymarket conditionId). */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** YES outcome token identifier. */
  yesTokenId: string;
  /** NO outcome token identifier. */
  noTokenId: string;
  /** Current mid-price (implied probability). */
  midpoint: number;
  /** Volume observed in the current period. */
  volume: number;
  /** Current open interest. */
  openInterest: number;
  /** Largest wallet's share of recent volume. */
  topWalletShare: number;
  /** Time until market close (ms). */
  timeToCloseMs: number;
  /** Snapshot timestamp in ms since epoch. */
  timestampMs: number;
}

/** Current-period snapshot plus prior-period rolling history. */
export interface MarketContext {
  /** Latest snapshot (current period). */
  snapshot: TradeMomentumSnapshot;
  /** Prior-period snapshots (oldest → newest), excludes current. */
  history: TradeMomentumSnapshot[];
}

/** Injectable dependencies for the scan layer. */
export interface ScanDeps {
  /** Fetch the current set of market snapshots. */
  fetchSnapshots: () => Promise<TradeMomentumSnapshot[]>;
  /** Clock override (ms). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

/** Scanner instance returned by `createScanner`. */
export interface Scanner {
  /** Perform one scan cycle and return per-market contexts. */
  scan(): Promise<MarketContext[]>;
}

/**
 * Create a stateful scanner with per-market rolling history.
 *
 * Behaviour per cycle:
 * 1. Fetch current snapshots via `deps.fetchSnapshots`
 * 2. Drop markets with `timeToCloseMs < minTimeToCloseHours` (24h floor)
 * 3. Load prior history, prune stale entries (age > `signalTtlMs`)
 * 4. Emit a MarketContext per viable market
 * 5. Append the current snapshot to history (capped at `historyCap`)
 */
interface HistoryEntry {
  snapshot: TradeMomentumSnapshot;
  recordedAt: number;
}

export function createScanner(
  config: TradeMomentumConfig,
  deps: ScanDeps,
): Scanner {
  const histories = new Map<string, HistoryEntry[]>();
  const clock = deps.now ?? ((): number => Date.now());
  const hardFloorMs = config.minTimeToCloseHours * HOUR_MS;

  async function scan(): Promise<MarketContext[]> {
    const snapshots = await deps.fetchSnapshots();
    const nowMs = clock();
    const contexts: MarketContext[] = [];

    for (const snapshot of snapshots) {
      if (snapshot.timeToCloseMs < hardFloorMs) {
        continue;
      }

      const prior = histories.get(snapshot.conditionId) ?? [];
      const pruned = prior.filter(
        (entry) => nowMs - entry.recordedAt <= config.signalTtlMs,
      );

      contexts.push({
        snapshot,
        history: pruned.map((entry) => entry.snapshot),
      });

      const updated = [...pruned, { snapshot, recordedAt: nowMs }];
      const capped =
        updated.length > config.historyCap
          ? updated.slice(updated.length - config.historyCap)
          : updated;
      histories.set(snapshot.conditionId, capped);
    }

    return contexts;
  }

  return { scan };
}
