/**
 * MINT-04 Market Making Premium — Signal Evaluation
 *
 * Scanner-only logic: given a market snapshot, decides whether a mint-and-
 * post-limit-sells cycle is viable. Does NOT issue orders.
 *
 * Evaluation pipeline (in order):
 *   1. Volume floor       — < $10k → MINT-02 advisory, reject.
 *   2. Confluence gate    — require ≥2 of {volume>20k, trades≥10, spread<1.5c}.
 *   3. Offset selection   — volume>$50k → +1.0c, $10k–$50k → +0.75c.
 *   4. Low-activity guard — trade_count_1h < 3 → downgrade to +0.5c + warn.
 *   5. Hurdle rate gate   — projectedNet / cycleCapital < 1.33% → reject.
 */

import { projectedNetPerCycle, type MintPremiumConfig } from "./config.js";

/**
 * Single-market input to the signal evaluator.
 *
 * Supports both snake_case (per C2/D2 source specs) and camelCase
 * (per runner / scan conventions) field names so that the same type
 * flows through the scanner and the signal layer unchanged.
 */
export interface MintPremiumSnapshot {
  /** Polymarket conditionId or platform-specific market identifier. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** Midpoint price (YES) in [0, 1]. */
  midpoint: number;
  /** Milliseconds remaining until market close. */
  timeToCloseMs: number;
  /** 24h quote volume in USD (snake_case variant). */
  volume_24h?: number;
  /** Trades in the last hour (snake_case variant). */
  trade_count_1h?: number;
  /** Bid-ask spread in probability units (snake_case variant). */
  bid_ask_spread?: number;
  /** 24h quote volume in USD (camelCase variant). */
  volume24h?: number;
  /** Trades in the last hour (camelCase variant). */
  tradeCount1h?: number;
  /** Bid-ask spread in probability units (camelCase variant). */
  bidAskSpread?: number;
  /** Polymarket YES token id. */
  yesTokenId?: string;
  /** Polymarket NO token id. */
  noTokenId?: string;
}

/** Result of evaluating a single market for a MINT-04 cycle. */
export interface MintPremiumSignal {
  /** True when all gates pass. */
  viable: boolean;
  /** Chosen offset in probability units (e.g. 0.0075 for +0.75c). */
  offsetC: number;
  /** Projected net profit in USD for one cycle. */
  projectedNet: number;
  /** Explanation — required when !viable, optional advisory when viable. */
  reason?: string;
}

function volumeOf(s: MintPremiumSnapshot): number {
  return s.volume_24h ?? s.volume24h ?? 0;
}

function tradesOf(s: MintPremiumSnapshot): number {
  return s.trade_count_1h ?? s.tradeCount1h ?? 0;
}

function spreadOf(s: MintPremiumSnapshot): number {
  return s.bid_ask_spread ?? s.bidAskSpread ?? Number.POSITIVE_INFINITY;
}

/**
 * Evaluate a market snapshot for a MINT-04 mint-premium cycle.
 *
 * Returns `{ viable, offsetC, projectedNet, reason? }`. On rejection the
 * `reason` string contains a stable marker (`MINT-02`, `confluence`,
 * `hurdle`) so callers can route downstream advisories.
 */
export function evaluateMintPremiumOpportunity(
  snapshot: MintPremiumSnapshot,
  config: MintPremiumConfig,
): MintPremiumSignal {
  const volume = volumeOf(snapshot);
  const trades = tradesOf(snapshot);
  const spread = spreadOf(snapshot);
  const projectedNet = projectedNetPerCycle(config);

  // 1. Volume floor → downgrade advisory.
  if (volume < config.volumeDowngradeThreshold) {
    return {
      viable: false,
      offsetC: 0,
      projectedNet,
      reason:
        `Volume $${volume} below $${config.volumeDowngradeThreshold} floor;` +
        ` advisory: downgrade to MINT-02 (passive quoting).`,
    };
  }

  // 2. Confluence gate (≥2 of 3).
  const confluencePassed =
    (volume > config.volume24hThreshold ? 1 : 0) +
    (trades >= config.trades1hThreshold ? 1 : 0) +
    (spread < config.spreadThreshold ? 1 : 0);
  if (confluencePassed < 2) {
    return {
      viable: false,
      offsetC: 0,
      projectedNet,
      reason:
        `Confluence check failed (${confluencePassed}/3):` +
        ` volume=${volume}, trades=${trades}, spread=${spread}.`,
    };
  }

  // 3. Offset selection by volume bracket.
  let offsetC =
    volume > config.volumeAggressiveThreshold
      ? config.offsetAggressiveC
      : config.offsetDefaultC;
  let reason: string | undefined;

  // 4. Low-activity guard — downgrade to defensive offset and warn.
  if (trades < config.minTradesPerHour) {
    offsetC = config.offsetDefensiveC;
    reason =
      `low_activity: trade_count_1h=${trades} below` +
      ` minTradesPerHour=${config.minTradesPerHour}; offset downgraded.`;
  }

  // 5. Hurdle rate gate.
  const netReturn = projectedNet / config.cycleCapital;
  if (netReturn < config.hurdleRate) {
    return {
      viable: false,
      offsetC,
      projectedNet,
      reason:
        `Hurdle rate not met: net/capital=${netReturn.toFixed(5)} <` +
        ` ${config.hurdleRate}.`,
    };
  }

  const result: MintPremiumSignal = {
    viable: true,
    offsetC,
    projectedNet,
  };
  if (reason !== undefined) {
    result.reason = reason;
  }
  return result;
}
