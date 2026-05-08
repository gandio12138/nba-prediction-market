/**
 * MINT-04 Market Making Premium — Runner Composition
 *
 * Wires scan → signal → risk → executor into the shared runner via DI.
 * Scanner-only: no `mint_set` tx, no `postLimitOrder` — this template
 * detects viable mint-premium cycles and emits TradeSignals for logging.
 *
 * Non-viable markets whose signal reason carries the MINT-02 marker
 * surface a downgrade advisory directly through the execution log so the
 * operator can route capital into the passive quoting strategy instead.
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
import { scanMarkets } from "./scan.js";
import type { ScanDeps } from "./scan.js";
import {
  evaluateMintPremiumOpportunity,
  type MintPremiumSnapshot,
} from "./signal.js";
import { createRiskChecker } from "./risk.js";
import type { MintPremiumConfig } from "./config.js";

const AUTOMATION_ID = "mm-premium";
const MINT_02_MARKER = "mint-02";

/** Full configuration for the MINT-04 runner. */
export interface MintPremiumRunnerConfig {
  /** Strategy-specific parameters (signal detection + scan). */
  strategy: MintPremiumConfig;
  /** Shared runner parameters (poll interval, dry-run, paths). */
  runner: RunnerConfig;
  /** Consecutive losses before circuit breaker trips (reserved). */
  maxConsecutiveLosses: number;
}

/** Injectable dependencies for the MINT-04 runner. */
export interface MintPremiumRunnerDeps {
  /** Scan layer dependencies (fetchSnapshots). */
  scan: ScanDeps;
  /** Order executor — submits approved signals (unused in dry-run). */
  executor: ExecutorDeps;
  /** Position manager — provides portfolio state. */
  positions: PositionDeps;
  /** Optional log override (defaults to file-based appendEntry). */
  log?: ((entry: ExecutionLogEntry) => void) | undefined;
}

function buildSignal(
  snap: MintPremiumSnapshot,
  offsetC: number,
  projectedNet: number,
  config: MintPremiumConfig,
): TradeSignal {
  return {
    automation_id: AUTOMATION_ID,
    timestamp: new Date(),
    market: {
      platform: "polymarket",
      market_id: snap.conditionId,
      question: snap.question,
    },
    direction: "sell_yes",
    size: config.cycleCapital,
    confidence: 0.7,
    urgency: "opportunistic",
    metadata: {
      timeToCloseMs: snap.timeToCloseMs,
      projectedNet,
      cycleCapital: config.cycleCapital,
      offsetC,
      midpoint: snap.midpoint,
      ...(snap.yesTokenId !== undefined ? { yesTokenId: snap.yesTokenId } : {}),
      ...(snap.noTokenId !== undefined ? { noTokenId: snap.noTokenId } : {}),
    },
  };
}

function advisoryEntry(
  snap: MintPremiumSnapshot,
  reason: string,
): ExecutionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    type: "error",
    automation_id: AUTOMATION_ID,
    market_id: snap.conditionId,
    data: {
      reason,
      advisory: "downgrade to MINT-02 (passive quoting)",
    },
  };
}

/**
 * Create a MINT-04 mint-premium scanner runner.
 *
 * Composes the scan layer, signal evaluation, risk checks, executor, and
 * position manager into the shared runner via dependency injection. Low-
 * volume markets emit a MINT-02 downgrade advisory directly into the log.
 */
export function createMintPremiumRunner(
  config: MintPremiumRunnerConfig,
  deps: MintPremiumRunnerDeps,
): Runner {
  const risk = createRiskChecker(config.strategy);

  const log =
    deps.log ??
    ((entry: ExecutionLogEntry) =>
      appendEntry(config.runner.baseDir, entry));

  const strategy = async (): Promise<TradeSignal[]> => {
    const snapshots = await scanMarkets(config.strategy, deps.scan);
    const signals: TradeSignal[] = [];

    for (const snap of snapshots) {
      const opp = evaluateMintPremiumOpportunity(snap, config.strategy);
      if (!opp.viable) {
        if (
          opp.reason !== undefined &&
          opp.reason.toLowerCase().includes(MINT_02_MARKER)
        ) {
          log(advisoryEntry(snap, opp.reason));
        }
        continue;
      }
      signals.push(
        buildSignal(snap, opp.offsetC, opp.projectedNet, config.strategy),
      );
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
