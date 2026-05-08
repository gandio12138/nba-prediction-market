/**
 * ARB-01 Binary Arbitrage — Signal Detection
 *
 * Pure function: takes pre-fetched market data and config,
 * returns TradeSignal[] for markets with arbitrage edges.
 *
 * Implements the edge-detection algorithm for ARB-01 binary arbitrage.
 */

import type { TradeSignal } from "../../types/TradeSignal.js";

/** Market data from the scan layer — input to signal detection. */
export interface MarketData {
  /** Polymarket condition ID. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** Market category (e.g. "NBA", "crypto"). */
  category: string;
  /** Best ask price for the YES outcome (0.0-1.0). */
  yesAsk: number;
  /** Best ask price for the NO outcome (0.0-1.0). */
  noAsk: number;
  /** CLOB token ID for the YES outcome. */
  yesTokenId: string;
  /** CLOB token ID for the NO outcome. */
  noTokenId: string;
  /** Estimated slippage as a fraction (e.g. 0.001 = 0.1%). */
  estimatedSlippage: number;
}

/** Configuration for the ARB-01 signal detector. */
export interface ArbBinaryConfig {
  /** Required category filter — no scan-all mode. */
  category: string;
  /** Platform fee rate per trade (e.g. 0.02 = 2%). */
  feeRate: number;
  /** Flat gas cost per signal in USD. */
  gasCost: number;
  /** Minimum net return threshold (e.g. 0.015 = 1.5%). */
  hurdleRate: number;
  /** Max estimated slippage before aborting (e.g. 0.003 = 0.3%). */
  slippageAbort: number;
  /** Total bankroll in USD. */
  bankroll: number;
  /** Kelly criterion fraction (e.g. 0.25 = quarter Kelly). */
  kellyFraction: number;
  /** Max single-position exposure as fraction of bankroll. */
  maxExposure: number;
  /** Signal time-to-live in milliseconds. */
  signalTtlMs: number;
}

/**
 * Detect binary arbitrage opportunities in market data.
 *
 * For each market matching the config category:
 * 1. Category filter — skip markets outside target category
 * 2. Slippage abort — skip if estimated slippage >= abort threshold
 * 3. Edge detection — YES_ask + NO_ask must be < $1.00
 * 4. Fee deduction — platform fee on cost + flat gas cost
 * 5. Hurdle rate — net return must meet minimum threshold
 * 6. Sizing — quarter-Kelly capped at max exposure
 * 7. Emit buy_yes + buy_no TradeSignal pair
 */
export function detectSignals(
  markets: MarketData[],
  config: ArbBinaryConfig,
): TradeSignal[] {
  const signals: TradeSignal[] = [];

  for (const market of markets) {
    if (market.category !== config.category) continue;
    if (market.estimatedSlippage >= config.slippageAbort) continue;

    const cost = market.yesAsk + market.noAsk;
    if (cost >= 1.0) continue;

    const grossEdge = 1.0 - cost;
    const totalFees = cost * config.feeRate + config.gasCost;
    const netEdge = grossEdge - totalFees;
    const netReturn = netEdge / cost;

    if (netReturn < config.hurdleRate) continue;

    const rawSize = config.bankroll * netReturn * config.kellyFraction;
    const maxSize = config.bankroll * config.maxExposure;
    const numContracts = Math.min(rawSize, maxSize) / cost;
    const confidence = Math.min(netReturn, 1.0);
    const now = new Date();

    const metadata: Record<string, unknown> = {
      grossEdge,
      totalFees,
      netEdge,
      netReturn,
      cost,
      yesAsk: market.yesAsk,
      noAsk: market.noAsk,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      estimatedSlippage: market.estimatedSlippage,
    };

    const marketRef: TradeSignal["market"] = {
      platform: "polymarket",
      market_id: market.conditionId,
      question: market.question,
    };

    signals.push({
      automation_id: "arb-binary",
      timestamp: now,
      market: marketRef,
      direction: "buy_yes",
      size: numContracts,
      confidence,
      urgency: "immediate",
      metadata,
    });

    signals.push({
      automation_id: "arb-binary",
      timestamp: now,
      market: { ...marketRef },
      direction: "buy_no",
      size: numContracts,
      confidence,
      urgency: "immediate",
      metadata: { ...metadata },
    });
  }

  return signals;
}
