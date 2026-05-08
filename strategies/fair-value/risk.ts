/**
 * IA-03 Fair Value — Risk Gate
 *
 * Implements `RiskInterface` for the fair-value scanner: signal TTL,
 * limit-only intent enforcement, time-to-close floor, liquidity floors,
 * concurrent-position count cap, exposure clamp (per-position cap,
 * aggregate headroom, live-wallet capital), and circuit breaker.
 *
 * Sizing math uses `config.bankroll` (the persisted bankroll set at
 * project init, see `bankroll.ts`). `portfolio.total_value` is used
 * only as a hard floor — the strategy will never approve more exposure
 * than the wallet can actually cover.
 */

import { clampToHeadroom } from "../../risk-clamp.js";
import type {
  AutomationExposure,
  Portfolio,
  RiskDecision,
  RiskInterface,
} from "../../types/RiskInterface.js";
import type { TradeSignal } from "../../types/TradeSignal.js";
import type { FairValueConfig } from "./config.js";

function reject(reason: string): RiskDecision {
  return { approved: false, rejection_reason: reason };
}

function readNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | undefined {
  const raw = metadata[key];
  return typeof raw === "number" ? raw : undefined;
}

function readBoolean(
  metadata: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = metadata[key];
  return typeof raw === "boolean" ? raw : undefined;
}

/**
 * Build a stateful risk checker for the fair-value strategy.
 *
 * The optional `now` clock is injected for deterministic TTL checks in
 * tests; in production it defaults to `new Date()`.
 */
export function createRiskChecker(
  config: FairValueConfig,
  now: () => Date = () => new Date(),
): RiskInterface {
  let circuitBreakerTripped = false;
  let circuitBreakerReason = "";

  function preTradeCheck(
    signal: TradeSignal,
    portfolio: Portfolio,
  ): RiskDecision {
    if (circuitBreakerTripped) {
      return reject(`Circuit breaker halted: ${circuitBreakerReason}`);
    }

    const ageMs = now().getTime() - signal.timestamp.getTime();
    if (ageMs > config.signalTtlMs) {
      return reject(
        `Signal stale: age ${ageMs}ms exceeds TTL ${config.signalTtlMs}ms`,
      );
    }

    const limitOnly = readBoolean(signal.metadata, "limitOnly");
    if (limitOnly !== true) {
      return reject("Limit-only intent required — market orders not allowed");
    }

    const timeToCloseMs = readNumber(signal.metadata, "timeToCloseMs");
    const minCloseMs = config.minTimeToCloseDays * 24 * 60 * 60 * 1000;
    if (timeToCloseMs === undefined || timeToCloseMs < minCloseMs) {
      return reject(
        `Time-to-close ${timeToCloseMs ?? "unknown"}ms below floor of ` +
          `${config.minTimeToCloseDays}d`,
      );
    }

    const volume24h = readNumber(signal.metadata, "volume24h");
    if (volume24h === undefined || volume24h <= config.minVolume24h) {
      return reject(
        `Liquidity: volume_24h $${volume24h ?? "unknown"} not above ` +
          `$${config.minVolume24h}`,
      );
    }
    const openInterest = readNumber(signal.metadata, "openInterest");
    if (openInterest === undefined || openInterest <= config.minOpenInterest) {
      return reject(
        `Liquidity: openInterest $${openInterest ?? "unknown"} not above ` +
          `$${config.minOpenInterest}`,
      );
    }

    if (portfolio.positions.length >= config.maxConcurrent) {
      return reject(
        `Max concurrent positions reached: ` +
          `${portfolio.positions.length}/${config.maxConcurrent}`,
      );
    }

    const openExposure = portfolio.positions.reduce(
      (sum, p) => sum + p.size,
      0,
    );
    return clampToHeadroom(signal.size, [
      {
        name: "per-position",
        value: config.bankroll * config.maxExposurePerPosition,
      },
      {
        name: "aggregate headroom",
        value:
          config.bankroll
          * config.maxExposurePerPosition
          * config.maxConcurrent
          - openExposure,
      },
      {
        name: "live capital",
        value: portfolio.total_value - openExposure,
      },
    ]);
  }

  function getExposure(): AutomationExposure {
    return {
      total_capital_deployed: 0,
      position_count: 0,
      largest_position: 0,
      markets: [],
    };
  }

  function onCircuitBreaker(reason: string): void {
    circuitBreakerTripped = true;
    circuitBreakerReason = reason;
  }

  return { preTradeCheck, getExposure, onCircuitBreaker };
}
