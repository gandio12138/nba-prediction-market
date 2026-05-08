/**
 * ARB-03 NegRisk Multi-condition Buy — Entry Point
 *
 * Wires scan, signal, risk, and executor into the shared runner via
 * dependency injection. Produces one TradeSignal per leg of an approved
 * NegRisk arb bundle and enforces a signal-freshness (TTL) cutoff before
 * handing signals to the runner.
 */

import { createRunner } from "../../runner.js";
import type {
  ExecutorDeps,
  PositionDeps,
  Runner,
  RunnerConfig,
} from "../../runner.js";
import { appendEntry } from "../../execution-log.js";
import type { ExecutionLogEntry } from "../../execution-log.js";
import type {
  AutomationExposure,
  RiskDecision,
  RiskInterface,
} from "../../types/RiskInterface.js";
import type { TradeSignal } from "../../types/TradeSignal.js";
import type { NegRiskBuyConfig } from "./config.js";
import {
  evaluateNegRiskOpportunity,
  type NegRiskOpportunity,
} from "./signal.js";
import { createRiskChecker } from "./risk.js";
import { scanMarkets } from "./scan.js";
import type { ScanDeps } from "./scan.js";

const AUTOMATION_ID = "arb-negrisk-buy";
const OPPORTUNITY_KEY = "__negRiskOpportunity";

/** Full configuration for the ARB-03 runner. */
export interface NegRiskBuyRunnerConfig {
  /** Strategy-specific parameters (scan + signal + risk sizing). */
  strategy: NegRiskBuyConfig;
  /** Shared runner parameters (poll interval, dry-run, paths). */
  runner: RunnerConfig;
  /** Consecutive losses before the circuit breaker trips. */
  maxConsecutiveLosses: number;
}

/** Injectable dependencies for the ARB-03 runner. */
export interface NegRiskBuyRunnerDeps {
  /** Scan layer dependencies (searchMarkets, fetchOrderBook). */
  scan: ScanDeps;
  /** Order executor — submits approved signals (skipped in dry-run). */
  executor: ExecutorDeps;
  /** Position manager — provides portfolio state. */
  positions: PositionDeps;
  /** Optional log override (defaults to file-based appendEntry). */
  log?: ((entry: ExecutionLogEntry) => void) | undefined;
  /** Clock override for deterministic TTL testing. */
  now?: () => Date;
}

function signalsForOpportunity(
  opp: NegRiskOpportunity,
  timestamp: Date,
): TradeSignal[] {
  const confidence = Math.min(Math.max(opp.netEdge, 0), 1);
  const signals: TradeSignal[] = [];
  for (const leg of opp.market.legs) {
    signals.push({
      automation_id: AUTOMATION_ID,
      timestamp,
      market: {
        platform: "polymarket",
        market_id: opp.market.conditionId,
        question: opp.market.question,
      },
      direction: "buy_yes",
      size: 0,
      confidence,
      urgency: "immediate",
      metadata: {
        outcome: leg.outcome,
        tokenId: leg.tokenId,
        yesBid: leg.yesBid,
        liquidity: leg.liquidity,
        sum: opp.sum,
        grossEdge: opp.grossEdge,
        totalFees: opp.totalFees,
        gasCost: opp.gasCost,
        netEdge: opp.netEdge,
        legCount: opp.legCount,
        [OPPORTUNITY_KEY]: opp,
      },
    });
  }
  return signals;
}

/**
 * Create an ARB-03 NegRisk multi-leg arbitrage runner.
 *
 * Composes the scan layer, signal evaluator, risk checker, executor,
 * and position manager into the shared runner. Signals older than
 * `config.strategy.signalTtlMs` at the point of handoff are dropped.
 */
export function createNegRiskBuyRunner(
  config: NegRiskBuyRunnerConfig,
  deps: NegRiskBuyRunnerDeps,
): Runner {
  const risk = createRiskChecker({
    bankroll: config.strategy.bankroll,
    kellyFraction: config.strategy.kellyFraction,
    maxExposure: config.strategy.maxExposure,
    minLegLiquidity: config.strategy.minLegLiquidity,
    maxLegPriceWithLowLiq: config.strategy.maxLegPriceWithLowLiq,
    lowLiqThreshold: config.strategy.lowLiqThreshold,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
  });
  const now = deps.now ?? (() => new Date());
  const ttlMs = config.strategy.signalTtlMs;

  const strategy = async (): Promise<TradeSignal[]> => {
    const markets = await scanMarkets(config.strategy, deps.scan);
    const fresh: TradeSignal[] = [];

    for (const market of markets) {
      const opp = evaluateNegRiskOpportunity(market, config.strategy);
      if (opp === null) continue;
      const stamped = now();
      fresh.push(...signalsForOpportunity(opp, stamped));
    }

    if (fresh.length === 0) return fresh;

    const cutoff = now();
    return fresh.filter(
      (s) => cutoff.getTime() - s.timestamp.getTime() <= ttlMs,
    );
  };

  const riskAdapter: RiskInterface = {
    preTradeCheck(signal, portfolio): RiskDecision {
      const opp = signal.metadata[OPPORTUNITY_KEY] as
        | NegRiskOpportunity
        | undefined;
      if (opp === undefined) {
        return {
          approved: false,
          rejection_reason: "Missing NegRisk opportunity in signal metadata",
        };
      }
      const decision = risk.preTradeCheck(opp, portfolio);
      return {
        approved: decision.approved,
        rejection_reason: decision.rejection_reason,
        modified_size: decision.per_leg_size,
      };
    },
    getExposure(): AutomationExposure {
      return {
        total_capital_deployed: 0,
        position_count: 0,
        largest_position: 0,
        markets: [],
      };
    },
    onCircuitBreaker(_reason: string): void {
      void _reason;
    },
  };

  const log =
    deps.log ??
    ((entry: ExecutionLogEntry) => appendEntry(config.runner.baseDir, entry));

  return createRunner(config.runner, {
    strategy,
    risk: riskAdapter,
    executor: deps.executor,
    positions: deps.positions,
    log,
  });
}

