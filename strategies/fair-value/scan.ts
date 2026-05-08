/**
 * IA-03 Fair Value Probability Model — Scan Layer
 *
 * Polls prediction-market snapshots, maintains a per-market rolling
 * history pruned by `config.signalTtlMs`, drops markets inside the
 * `minTimeToCloseDays` floor, and invokes the configured
 * `ProbabilityModel` once per viable snapshot. Emits a
 * `FairValueCandidate` (snapshot + history + modelResult) for every
 * surviving market; downstream layers (main.ts) handle divergence
 * tiering, confluence, sizing, and risk gates.
 *
 * Purely statistical — the injected model receives numeric snapshots
 * plus history only.
 */

import type { FairValueConfig } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One prediction-market snapshot at a single poll cycle. */
export interface FairValueSnapshot {
  /** Polymarket condition ID. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** YES outcome token identifier. */
  yesTokenId: string;
  /** NO outcome token identifier. */
  noTokenId: string;
  /** Current YES mid-price as a probability (0.0–1.0). */
  marketPrice: number;
  /** 24h USD volume. */
  volume24h: number;
  /** Open interest in USD. */
  openInterest: number;
  /** Milliseconds until market close. */
  timeToCloseMs: number;
  /** Snapshot timestamp in ms since epoch. */
  timestampMs: number;
}

/** Context passed to the pluggable scan-layer probability model. */
export interface ModelContext {
  /** Latest snapshot (current cycle). */
  snapshot: FairValueSnapshot;
  /** Prior-cycle snapshots (oldest → newest, excludes current). */
  history: FairValueSnapshot[];
}

/** Output of a probability model for a single market. */
export interface ModelResult {
  /** Estimated fair probability (0.0–1.0). */
  fairValue: number;
  /** Source identifiers feeding the estimate (for confluence gating). */
  sources: string[];
  /** Model-reported confidence (0.0–1.0). */
  confidence: number;
}

/** Scan-layer pluggable probability model interface. */
export interface ProbabilityModel {
  computeFairValue(ctx: ModelContext): ModelResult;
}

/** Per-market output of one scan cycle. */
export interface FairValueCandidate {
  /** Latest snapshot observed this cycle. */
  snapshot: FairValueSnapshot;
  /** Prior snapshots (oldest → newest, excludes current). */
  history: FairValueSnapshot[];
  /** Fair-value estimate returned by the model for this cycle. */
  modelResult: ModelResult;
}

/** Injectable dependencies for the scan layer. */
export interface ScanDeps {
  /** Fetch the current set of market snapshots. */
  fetchSnapshots: () => Promise<FairValueSnapshot[]>;
  /** Pluggable probability model. */
  model: ProbabilityModel;
  /** Clock override (ms). Defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

/** Scanner instance returned by `createScanner`. */
export interface Scanner {
  /** Run one scan cycle and return per-market candidates. */
  scan(): Promise<FairValueCandidate[]>;
}

interface HistoryEntry {
  snapshot: FairValueSnapshot;
  recordedAt: number;
}

/**
 * Create a stateful fair-value scanner with per-market rolling history.
 *
 * Per cycle:
 * 1. Fetch current snapshots via `deps.fetchSnapshots`.
 * 2. Drop markets with `timeToCloseMs < minTimeToCloseDays * 1d`.
 * 3. Load prior history, prune entries older than `signalTtlMs`.
 * 4. Invoke `deps.model.computeFairValue({snapshot, history})`.
 * 5. Emit a `FairValueCandidate` per surviving market.
 * 6. Append the current snapshot to history for the next cycle.
 */
export function createScanner(
  config: FairValueConfig,
  deps: ScanDeps,
): Scanner {
  const histories = new Map<string, HistoryEntry[]>();
  const clock = deps.now ?? ((): number => Date.now());
  const hardFloorMs = config.minTimeToCloseDays * DAY_MS;

  async function scan(): Promise<FairValueCandidate[]> {
    const snapshots = await deps.fetchSnapshots();
    const nowMs = clock();
    const candidates: FairValueCandidate[] = [];

    for (const snapshot of snapshots) {
      if (snapshot.timeToCloseMs < hardFloorMs) {
        continue;
      }

      const prior = histories.get(snapshot.conditionId) ?? [];
      const pruned = prior.filter(
        (entry) => nowMs - entry.recordedAt <= config.signalTtlMs,
      );
      const history = pruned.map((entry) => entry.snapshot);

      const modelResult = deps.model.computeFairValue({ snapshot, history });
      candidates.push({ snapshot, history, modelResult });

      histories.set(snapshot.conditionId, [
        ...pruned,
        { snapshot, recordedAt: nowMs },
      ]);
    }

    return candidates;
  }

  return { scan };
}
