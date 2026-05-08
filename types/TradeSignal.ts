/**
 * TradeSignal — the universal output interface for all Canon strategies.
 *
 * Defined in Canon_AI_Automations.md § Shared Interfaces.
 * Every strategy produces TradeSignals; the runner decides whether to execute.
 */

/** Identifies which prediction market platform and market a signal targets. */
export interface MarketReference {
  /** Platform hosting the market. Aligns with pmxt supported exchanges. */
  platform: "polymarket" | "kalshi" | "limitless" | "probable" | "other";
  /** Platform-specific market identifier (e.g. Polymarket conditionId). */
  market_id: string;
  /** Human-readable market question text. */
  question: string;
}

/** A trading signal emitted by a strategy after detecting an edge. */
export interface TradeSignal {
  /** Which automation generated this signal (e.g. "sports-arb-v1"). */
  automation_id: string;
  /** When the signal was generated. */
  timestamp: Date;
  /** Target market reference. */
  market: MarketReference;
  /** Trading direction. */
  direction: "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
  /** Order size in contracts or USD equivalent. */
  size: number;
  /** Signal confidence as a probability (0.0–1.0). */
  confidence: number;
  /** How quickly the signal should be acted on. */
  urgency: "immediate" | "normal" | "opportunistic";
  /** Strategy-specific data (edge breakdown, source odds, etc.). */
  metadata: Record<string, unknown>;
}
