/**
 * TRADE-02 Momentum Trading — Risk Checks
 *
 * Implements RiskInterface for pre-trade risk gating:
 * - Per-position exposure cap (10% of bankroll) — clamped via modified_size
 * - Aggregate exposure cap (30% = maxExposure × maxConcurrent) — clamped
 * - Live capital floor: total exposure cannot exceed portfolio.total_value
 * - Max concurrent open positions (3) — hard reject
 * - Hard floor: reject if timeToClose < 24h
 * - Manipulation guard: reject if topWalletShare > maxTopWalletShare
 * - Circuit breaker halts all approvals once tripped
 *
 * Sizing math uses `config.bankroll` (the persisted bankroll set at
 * project init, see `bankroll.ts`). The live `portfolio.total_value`
 * is used only as a hard floor — the strategy will never approve more
 * exposure than the wallet can actually cover, even if the persisted
 * bankroll is stale or operator-overridden.
 */

import { clampToHeadroom } from "../../risk-clamp.js";
import type { RiskInterface } from "../../types/RiskInterface.js";
import type { TradeMomentumConfig } from "./config.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Create the TRADE-02 risk checker.
 *
 * Check order in `preTradeCheck`:
 * 1. Circuit breaker
 * 2. Wallet-concentration manipulation guard
 * 3. 24h hard floor (timeToClose cutoff)
 * 4. Max concurrent positions
 * 5. Compute headroom from per-position cap, aggregate cap, live capital
 * 6. Approve at clamped size (or reject if no headroom remains)
 */
export function createRiskChecker(
  config: TradeMomentumConfig,
): RiskInterface {
  let circuitBreakerTripped = false;
  let circuitBreakerReason: string | undefined;

  return {
    preTradeCheck(signal, portfolio) {
      if (circuitBreakerTripped) {
        return {
          approved: false,
          rejection_reason:
            `Circuit breaker halted approvals:`
            + ` ${circuitBreakerReason ?? "tripped"}`,
        };
      }

      const topWalletShare = Number(signal.metadata["topWalletShare"] ?? 0);
      if (topWalletShare > config.maxTopWalletShare) {
        return {
          approved: false,
          rejection_reason:
            `Wallet concentration manipulation guard:`
            + ` topWalletShare=${topWalletShare.toFixed(3)}`
            + ` > ${config.maxTopWalletShare}`,
        };
      }

      const timeToCloseMs = Number(
        signal.metadata["timeToCloseMs"] ?? Number.POSITIVE_INFINITY,
      );
      const hardFloorMs = config.minTimeToCloseHours * HOUR_MS;
      if (timeToCloseMs < hardFloorMs) {
        const hours = (timeToCloseMs / HOUR_MS).toFixed(1);
        return {
          approved: false,
          rejection_reason:
            `timeToClose ${hours}h below ${config.minTimeToCloseHours}h`
            + ` hard-floor cutoff`,
        };
      }

      if (portfolio.positions.length >= config.maxConcurrent) {
        return {
          approved: false,
          rejection_reason:
            `Max concurrent positions reached:`
            + ` ${portfolio.positions.length} >= ${config.maxConcurrent}`,
        };
      }

      const currentExposure = portfolio.positions.reduce(
        (sum, pos) => sum + pos.size,
        0,
      );
      return clampToHeadroom(signal.size, [
        {
          name: "per-position",
          value: config.bankroll * config.maxExposure,
        },
        {
          name: "aggregate headroom",
          value:
            config.bankroll * config.maxExposure * config.maxConcurrent
            - currentExposure,
        },
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

    onCircuitBreaker(reason) {
      circuitBreakerTripped = true;
      circuitBreakerReason = reason;
    },
  };
}
