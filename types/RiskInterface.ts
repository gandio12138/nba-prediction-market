/**
 * RiskInterface — portfolio-level risk checks before trade execution.
 *
 * Defined in Canon_AI_Automations.md § Risk Interface.
 * Every strategy must implement RiskInterface. The runner calls
 * preTradeCheck before acting on any TradeSignal.
 */

import type { TradeSignal } from "./TradeSignal.js";

/** A single open position in the portfolio. */
export interface Position {
  /** Platform-specific market identifier. */
  market_id: string;
  /** Trading direction of this position. */
  direction: "buy_yes" | "buy_no" | "sell_yes" | "sell_no";
  /** Position size in USD. */
  size: number;
  /** Entry price as probability (0.0–1.0). */
  entry_price: number;
  /** When the position was opened. */
  opened_at: Date;
}

/** Portfolio snapshot used for risk calculations. */
export interface Portfolio {
  /** Total portfolio value in USD. */
  total_value: number;
  /** Current open positions. */
  positions: Position[];
  /** Realized + unrealized P&L for the current day in USD. */
  daily_pnl: number;
}

/** Result of a pre-trade risk check. */
export interface RiskDecision {
  /** Whether the trade is approved. */
  approved: boolean;
  /** Reason for rejection (present when approved is false). */
  rejection_reason?: string | undefined;
  /** Risk-adjusted size — risk agent may reduce the requested size. */
  modified_size?: number | undefined;
}

/** Current exposure snapshot for an automation. */
export interface AutomationExposure {
  /** Total capital currently deployed across all positions in USD. */
  total_capital_deployed: number;
  /** Number of open positions. */
  position_count: number;
  /** Largest single position size in USD. */
  largest_position: number;
  /** Market IDs with open positions. */
  markets: string[];
}

/** Portfolio-level risk gate that every strategy must implement. */
export interface RiskInterface {
  /** Called before any trade execution to approve or reject a signal. */
  preTradeCheck(
    signal: TradeSignal,
    portfolio: Portfolio,
  ): RiskDecision;

  /** Returns current portfolio exposure for this automation. */
  getExposure(): AutomationExposure;

  /** Called when a circuit breaker trips — strategy must halt activity. */
  onCircuitBreaker(reason: string): void;
}
