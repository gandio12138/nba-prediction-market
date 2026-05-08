/**
 * IA-03 Fair Value Probability Model — Runner Composition
 *
 * Wires scan (with injected `ProbabilityModel`) → divergence evaluation
 * → risk gate → executor into the shared runner via DI. Scanner-only:
 * approved signals are logged as dry-run JSONL entries; `executor.submit`
 * is never called while `dryRun: true`.
 *
 * The scan layer invokes the pluggable probability model; this layer
 * converts each `FairValueCandidate` into a `TradeSignal`, applying
 * the tiered Kelly sizing, confluence gate, and liquidity/runway
 * floors defined in `strategy.md`.
 */

import { createRunner } from "../../runner.js";
import type {
  Runner,
  RunnerConfig,
  ExecutorDeps,
  PositionDeps,
} from "../../runner.js";
import { appendEntry } from "../../execution-log.js";
import type { ExecutionLogEntry } from "../../execution-log.js";
import type { TradeSignal } from "../../types/TradeSignal.js";
import { createScanner } from "./scan.js";
import type {
  FairValueCandidate,
  FairValueSnapshot,
  ScanDeps,
} from "./scan.js";
import { divergenceTier, kellyFraction } from "./signal.js";
import { createRiskChecker } from "./risk.js";
import type { FairValueConfig } from "./config.js";

const AUTOMATION_ID = "fair-value";

/** Full configuration for the IA-03 runner. */
export interface FairValueRunnerConfig {
  /** Strategy parameters (tiers, confluence, liquidity, runway). */
  strategy: FairValueConfig;
  /** Shared runner parameters (poll interval, dry-run, paths). */
  runner: RunnerConfig;
}

/** Injectable dependencies for the IA-03 runner. */
export interface FairValueRunnerDeps {
  /** Scan layer dependencies (fetchSnapshots, model, optional clock). */
  scan: ScanDeps;
  /** Order executor — unused while `dryRun: true`. */
  executor: ExecutorDeps;
  /** Position manager — provides portfolio state. */
  positions: PositionDeps;
  /** Optional log override (defaults to file-based appendEntry). */
  log?: ((entry: ExecutionLogEntry) => void) | undefined;
}

function sizingMultiplierFor(tier: "full" | "half" | "none"): number {
  if (tier === "full") return 1.0;
  if (tier === "half") return 0.5;
  return 0;
}

/**
 * Volume-rising check for the confluence gate.
 *
 * Uses a robust "last bucket strictly greater than first" rule so that
 * flat series (equal across the window) do not register as rising even
 * when the rolling history length grows across polling cycles.
 */
function isVolumeRising(series: number[]): boolean {
  if (series.length < 2) return false;
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return last > first;
}

interface BuildOutcome {
  /** Emitted signal, when every gate passes. */
  signal?: TradeSignal;
}

function buildSignal(
  candidate: FairValueCandidate,
  config: FairValueConfig,
): BuildOutcome {
  const { snapshot, history, modelResult } = candidate;
  const { fairValue, sources, confidence } = modelResult;

  // Liquidity floors (strict >).
  if (snapshot.volume24h <= config.minVolume24h) return {};
  if (snapshot.openInterest <= config.minOpenInterest) return {};

  const divergence = fairValue - snapshot.marketPrice;
  const absDivergence = Math.abs(divergence);
  const tier = divergenceTier(absDivergence, config);
  if (tier === "none") return {};

  const volumeSeries = [
    ...history.map((h) => h.volume24h),
    snapshot.volume24h,
  ];
  const divergencePass = absDivergence >= config.minDivergencePp;
  const sourcesPass = sources.length >= config.minSources;
  const volumeRising = isVolumeRising(volumeSeries);
  const confluenceCount =
    (divergencePass ? 1 : 0) +
    (sourcesPass ? 1 : 0) +
    (volumeRising ? 1 : 0);
  if (confluenceCount < 2) return {};

  const sizingMultiplier = sizingMultiplierFor(tier);
  const size =
    kellyFraction({
      fair: fairValue,
      market: snapshot.marketPrice,
      haircut: config.kellyHaircut,
      sizingMultiplier,
    }) * config.bankroll;

  const direction: TradeSignal["direction"] =
    divergence > 0 ? "buy_yes" : "buy_no";

  const signal: TradeSignal = {
    automation_id: AUTOMATION_ID,
    timestamp: new Date(),
    market: {
      platform: "polymarket",
      market_id: snapshot.conditionId,
      question: snapshot.question,
    },
    direction,
    size,
    confidence,
    urgency: "normal",
    metadata: {
      orderType: "limit",
      limitOnly: true,
      yesTokenId: snapshot.yesTokenId,
      noTokenId: snapshot.noTokenId,
      fairValue,
      marketPrice: snapshot.marketPrice,
      divergence,
      tier,
      sizingMultiplier,
      sources,
      confluenceCount,
      timeToCloseMs: snapshot.timeToCloseMs,
      volume24h: snapshot.volume24h,
      openInterest: snapshot.openInterest,
    },
  };

  return { signal };
}

/**
 * Create an IA-03 fair-value scanner runner.
 *
 * Composes the scan layer (model injection), divergence/confluence
 * evaluation, risk gate, executor, and position manager into a single
 * `Runner`. Wraps `deps.log` so that `signal` log entries carry full
 * `TradeSignal.metadata` (including limit-only intent) — the shared
 * runner only records `{direction, size, confidence}` by default.
 */
export function createFairValueRunner(
  config: FairValueRunnerConfig,
  deps: FairValueRunnerDeps,
): Runner {
  const scanner = createScanner(config.strategy, deps.scan);
  const risk = createRiskChecker(config.strategy);

  const pendingMetadata = new Map<string, TradeSignal["metadata"]>();

  const rawLog =
    deps.log ??
    ((entry: ExecutionLogEntry): void =>
      appendEntry(config.runner.baseDir, entry));

  const log = (entry: ExecutionLogEntry): void => {
    if (entry.type === "signal") {
      const metadata = pendingMetadata.get(entry.market_id);
      if (metadata !== undefined) {
        const enriched: ExecutionLogEntry = {
          ...entry,
          data: { ...entry.data, metadata },
        };
        rawLog(enriched);
        return;
      }
    }
    rawLog(entry);
  };

  const strategy = async (): Promise<TradeSignal[]> => {
    const candidates = await scanner.scan();
    const signals: TradeSignal[] = [];
    for (const candidate of candidates) {
      const { signal } = buildSignal(candidate, config.strategy);
      if (!signal) continue;
      pendingMetadata.set(signal.market.market_id, signal.metadata);
      signals.push(signal);
    }
    return signals;
  };

  return createRunner(config.runner, {
    strategy,
    risk,
    executor: deps.executor,
    positions: deps.positions,
    log,
  });
}

export type { FairValueSnapshot } from "./scan.js";
