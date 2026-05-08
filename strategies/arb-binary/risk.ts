/**
 * ARB-01 Binary Arbitrage — Risk Checks
 *
 * Implements RiskInterface for pre-trade risk gating:
 * - Circuit breaker on consecutive losses
 * - Kelly-with-no-edge upfront reject (clearer than no-headroom)
 * - Exposure clamp: signal size is capped to the smaller of the
 *   per-position cap (`maxExposure × bankroll`), the Kelly-fractional
 *   size, and the live wallet capital — so the strategy never submits
 *   more than it can cover even if the persisted bankroll is stale or
 *   operator-overridden.
 *
 * Sizing math uses `config.bankroll` (the persisted bankroll set at
 * project init, see `bankroll.ts`). `portfolio.total_value` is used
 * only as a hard floor.
 */

import { clampToHeadroom } from "../../risk-clamp.js";
import type { RiskInterface } from "../../types/RiskInterface.js";

/** Configuration for the ARB-01 risk checker. */
export interface RiskConfig {
  /** Total bankroll in USD. */
  bankroll: number;
  /** Kelly criterion fraction (e.g. 0.25 = quarter Kelly). */
  kellyFraction: number;
  /** Max single-position exposure as fraction of bankroll. */
  maxExposure: number;
  /** Consecutive losses before circuit breaker trips. */
  maxConsecutiveLosses: number;
}

/** ARB-01 risk checker with outcome tracking for circuit breaker. */
export interface ArbBinaryRisk extends RiskInterface {
  /** Record a trade outcome to track consecutive losses. */
  recordOutcome(won: boolean): void;
}

/**
 * Create an ARB-01 risk checker implementing RiskInterface.
 *
 * The checker gates every signal through:
 * 1. Circuit breaker — reject if consecutive losses >= threshold
 * 2. Kelly-no-edge — reject if `kellyFraction × netReturn × bankroll ≤ 0`
 * 3. Clamp `signal.size` to the binding cap among per-position, Kelly,
 *    and live capital headroom; reject if no cap leaves fillable size.
 */
export function createRiskChecker(config: RiskConfig): ArbBinaryRisk {
  let consecutiveLosses = 0;

  return {
    preTradeCheck(signal, portfolio) {
      const { bankroll, kellyFraction, maxExposure, maxConsecutiveLosses } =
        config;

      if (consecutiveLosses >= maxConsecutiveLosses) {
        return {
          approved: false,
          rejection_reason:
            `Circuit breaker: ${consecutiveLosses} consecutive losses` +
            ` (limit ${maxConsecutiveLosses})`,
        };
      }

      const netReturn = Number(signal.metadata["netReturn"] ?? 0);
      const kellySize = bankroll * kellyFraction * netReturn;
      if (kellySize <= 0) {
        return {
          approved: false,
          rejection_reason:
            `Kelly sizing: computed size $${kellySize.toFixed(2)}` +
            ` (netReturn=${netReturn})`,
        };
      }

      const currentExposure = portfolio.positions.reduce(
        (sum, pos) => sum + pos.size,
        0,
      );
      return clampToHeadroom(signal.size, [
        { name: "per-position", value: maxExposure * bankroll },
        { name: "kelly", value: kellySize },
        {
          name: "live capital",
          value: portfolio.total_value - currentExposure,
        },
      ]);
    },

    getExposure() {
      return {
        total_capital_deployed: 0,
        position_count: 0,
        largest_position: 0,
        markets: [],
      };
    },

    onCircuitBreaker(_reason) {
      consecutiveLosses = config.maxConsecutiveLosses;
    },

    recordOutcome(won) {
      if (won) {
        consecutiveLosses = 0;
      } else {
        consecutiveLosses += 1;
      }
    },
  };
}
