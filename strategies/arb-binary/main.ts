/**
 * ARB-01 Binary Arbitrage — Entry Point
 *
 * Wires scan, signal, risk, and executor into the shared runner
 * via dependency injection.
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
import { scanMarkets } from "./scan.js";
import type { ScanDeps } from "./scan.js";
import { detectSignals } from "./signal.js";
import type { ArbBinaryConfig } from "./signal.js";
import { createRiskChecker } from "./risk.js";

/** Full configuration for the ARB-01 runner. */
export interface ArbBinaryRunnerConfig {
  /** Strategy-specific parameters (signal detection + scan). */
  strategy: ArbBinaryConfig;
  /** Shared runner parameters (poll interval, dry-run, paths). */
  runner: RunnerConfig;
  /** Consecutive losses before circuit breaker trips. */
  maxConsecutiveLosses: number;
}

/** Injectable dependencies for the ARB-01 runner. */
export interface ArbBinaryRunnerDeps {
  /** Scan layer dependencies (searchMarkets, fetchOrderBook). */
  scan: ScanDeps;
  /** Order executor — submits approved signals. */
  executor: ExecutorDeps;
  /** Position manager — provides portfolio state. */
  positions: PositionDeps;
  /** Optional log override (defaults to file-based appendEntry). */
  log?: ((entry: ExecutionLogEntry) => void) | undefined;
}

/**
 * Create an ARB-01 binary arbitrage runner.
 *
 * Composes the scan layer, signal detection, risk checks, executor,
 * and position manager into the shared runner via dependency injection.
 */
export function createArbBinaryRunner(
  config: ArbBinaryRunnerConfig,
  deps: ArbBinaryRunnerDeps,
): Runner {
  const risk = createRiskChecker({
    bankroll: config.strategy.bankroll,
    kellyFraction: config.strategy.kellyFraction,
    maxExposure: config.strategy.maxExposure,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
  });

  const strategy = async () => {
    const markets = await scanMarkets(config.strategy, deps.scan);
    return detectSignals(markets, config.strategy);
  };

  const log =
    deps.log ??
    ((entry: ExecutionLogEntry) =>
      appendEntry(config.runner.baseDir, entry));

  return createRunner(config.runner, {
    strategy,
    risk,
    executor: deps.executor,
    positions: deps.positions,
    log,
  });
}
