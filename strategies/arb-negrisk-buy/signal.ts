/**
 * ARB-03 NegRisk Multi-condition Buy — Signal Detection
 *
 * Pure evaluator for NegRisk multi-leg arbitrage opportunities.
 * Given a NegRisk market with N mutually-exclusive outcomes, compute
 * `sum(YES_bid_i)` across all legs and return an opportunity when the
 * confluence gate holds and net edge meets the hurdle.
 *
 *   sum      = Σ YES_bid_i
 *   grossEdge = 1.00 − sum
 *   fees     = feeRate × sum
 *   gas      = gasPerLeg × N
 *   netEdge  = grossEdge − fees − gas
 */

import type { NegRiskBuyConfig } from "./config.js";

/** One leg of a NegRisk market — a single YES outcome. */
export interface NegRiskLeg {
  /** CLOB token ID for the YES outcome on this leg. */
  tokenId: string;
  /** Human-readable outcome label (e.g. "Boston Celtics"). */
  outcome: string;
  /** Best YES bid price (0.0–1.0). */
  yesBid: number;
  /** Per-leg displayed liquidity in USD at the top of book. */
  liquidity: number;
}

/** A NegRisk market with N mutually-exclusive outcomes. */
export interface NegRiskMarket {
  /** Polymarket condition ID for the parent NegRisk event. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** Market category (e.g. "NBA Champion"). */
  category: string;
  /** True when the parent market is flagged NegRisk (`neg_risk` = true). */
  isNegRisk: boolean;
  /** The N mutually-exclusive legs. */
  legs: NegRiskLeg[];
}

/** A detected multi-leg arbitrage opportunity on a NegRisk market. */
export interface NegRiskOpportunity {
  /** Source market. */
  market: NegRiskMarket;
  /** Σ YES_bid_i across all legs. */
  sum: number;
  /** 1.00 − sum. */
  grossEdge: number;
  /** feeRate × sum. */
  totalFees: number;
  /** gasPerLeg × N. */
  gasCost: number;
  /** grossEdge − totalFees − gasCost. */
  netEdge: number;
  /** Number of legs (N). */
  legCount: number;
}

/**
 * Evaluate a NegRisk market for a multi-leg buy-all-YES arbitrage.
 *
 * Returns an opportunity when all gates pass:
 * 1. Market is flagged NegRisk.
 * 2. Market category matches `config.category`.
 * 3. At least 2 legs are present.
 * 4. Σ YES_bid_i is strictly below `config.sumThreshold` (confluence gate —
 *    also implies sum < 1.00).
 * 5. netEdge meets `config.hurdleRate`.
 *
 * Otherwise returns null. No side effects, no I/O.
 */
export function evaluateNegRiskOpportunity(
  market: NegRiskMarket,
  config: NegRiskBuyConfig,
): NegRiskOpportunity | null {
  if (!market.isNegRisk) return null;
  if (market.category !== config.category) return null;
  if (market.legs.length < 2) return null;

  const legCount = market.legs.length;
  let sum = 0;
  for (const leg of market.legs) {
    sum += leg.yesBid;
  }

  if (sum >= config.sumThreshold) return null;

  const grossEdge = 1.0 - sum;
  const totalFees = sum * config.feeRate;
  const gasCost = config.gasPerLeg * legCount;
  const netEdge = grossEdge - totalFees - gasCost;

  if (netEdge < config.hurdleRate) return null;

  return {
    market,
    sum,
    grossEdge,
    totalFees,
    gasCost,
    netEdge,
    legCount,
  };
}
