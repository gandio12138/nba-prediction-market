/**
 * TRADE-02 Momentum Trading — Runner Composition
 *
 * Wires scan → signal → risk → executor into the shared runner via DI.
 * Scanner-only: signals are emitted as dry-run JSONL entries; orders are
 * never submitted while `dryRun: true`.
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
  MarketContext,
  ScanDeps,
  TradeMomentumSnapshot,
} from "./scan.js";
import {
  evaluateMomentumOpportunity,
  type MomentumSnapshot,
} from "./signal.js";
import { createRiskChecker } from "./risk.js";
import type { TradeMomentumConfig } from "./config.js";

const AUTOMATION_ID = "trade-momentum";

/** Full configuration for the TRADE-02 runner. */
export interface TradeMomentumRunnerConfig {
  /** Strategy-specific parameters (signal detection + scan). */
  strategy: TradeMomentumConfig;
  /** Shared runner parameters (poll interval, dry-run, paths). */
  runner: RunnerConfig;
  /** Consecutive losses before circuit breaker trips (reserved). */
  maxConsecutiveLosses: number;
}

/** Injectable dependencies for the TRADE-02 runner. */
export interface TradeMomentumRunnerDeps {
  /** Scan layer dependencies (fetchSnapshots, optional clock). */
  scan: ScanDeps;
  /** Order executor — submits approved signals (unused in dry-run). */
  executor: ExecutorDeps;
  /** Position manager — provides portfolio state. */
  positions: PositionDeps;
  /** Optional log override (defaults to file-based appendEntry). */
  log?: ((entry: ExecutionLogEntry) => void) | undefined;
}

function buildMomentumSnapshot(ctx: MarketContext): MomentumSnapshot {
  const series = [...ctx.history, ctx.snapshot];
  const priceHistory = series.map((s) => s.midpoint);
  const volumeHistory = series.map((s) => s.volume);
  const oiHistory = series.map((s) => s.openInterest);
  return {
    conditionId: ctx.snapshot.conditionId,
    question: ctx.snapshot.question,
    priceHistory,
    volumeHistory,
    oiHistory,
    topWalletShare: ctx.snapshot.topWalletShare,
    timeToCloseMs: ctx.snapshot.timeToCloseMs,
  };
}

function buildTradeSignal(
  snapshot: TradeMomentumSnapshot,
  signalOutput: ReturnType<typeof evaluateMomentumOpportunity>,
  config: TradeMomentumConfig,
): TradeSignal {
  const size = config.bankroll * config.maxExposure;
  return {
    automation_id: AUTOMATION_ID,
    timestamp: new Date(),
    market: {
      platform: "polymarket",
      market_id: snapshot.conditionId,
      question: snapshot.question,
    },
    direction: "buy_yes",
    size,
    confidence: Math.min(1, 0.5 + 0.1 * signalOutput.confluenceCount),
    urgency: "normal",
    metadata: {
      entryPrice: snapshot.midpoint,
      yesTokenId: snapshot.yesTokenId,
      noTokenId: snapshot.noTokenId,
      exitTargetPrice: config.exitTargetPrice,
      deltaPrice: signalOutput.deltaPrice,
      volumePercentile: signalOutput.volumePercentile,
      rsi: signalOutput.rsi,
      macdCrossUp: signalOutput.macdCrossUp,
      oiTrend: signalOutput.oiTrend,
      confluenceCount: signalOutput.confluenceCount,
      projectedNet: signalOutput.projectedNet,
      topWalletShare: snapshot.topWalletShare,
      timeToCloseMs: snapshot.timeToCloseMs,
    },
  };
}

/**
 * Create a TRADE-02 momentum-trading scanner runner.
 *
 * Composes scan, signal evaluation, risk checks, executor, and position
 * manager via dependency injection into the shared runner.
 */
export function createTradeMomentumRunner(
  config: TradeMomentumRunnerConfig,
  deps: TradeMomentumRunnerDeps,
): Runner {
  const scanner = createScanner(config.strategy, deps.scan);
  const risk = createRiskChecker(config.strategy);

  const log =
    deps.log ??
    ((entry: ExecutionLogEntry): void =>
      appendEntry(config.runner.baseDir, entry));

  const strategy = async (): Promise<TradeSignal[]> => {
    const contexts = await scanner.scan();
    const signals: TradeSignal[] = [];

    for (const ctx of contexts) {
      const momentum = buildMomentumSnapshot(ctx);
      const evaluation = evaluateMomentumOpportunity(momentum, config.strategy);
      if (!evaluation.viable) {
        continue;
      }
      signals.push(buildTradeSignal(ctx.snapshot, evaluation, config.strategy));
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
