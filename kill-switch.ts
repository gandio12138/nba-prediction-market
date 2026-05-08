/**
 * Kill switch — emergency cancellation of all open orders and
 * optional closure of all positions.
 */

import {
  cancelOrder,
  createOrder,
  fetchPositions,
} from "./client-polymarket.js";
import type { RiskInterface } from "./types/RiskInterface.js";

const DEFAULT_MAX_RETRIES = 3;

/** Result of cancelling all open orders. */
export interface CancelAllResult {
  /** Order IDs that were successfully cancelled. */
  cancelled: string[];
  /** Order IDs that failed to cancel after all retries. */
  failed: string[];
}

/** Result of closing all open positions. */
export interface CloseAllResult {
  /** Outcome token IDs for positions that were successfully closed. */
  closed: string[];
  /** Outcome token IDs for positions that failed to close. */
  failed: string[];
}

/** Combined result from activating the kill switch. */
export interface KillSwitchResult {
  cancelResult: CancelAllResult;
  closeResult: CloseAllResult | null;
  circuitBreakerTriggered: boolean;
}

/** Options for the kill switch activation. */
export interface KillSwitchOptions {
  /** Whether to also close all positions (default: false). */
  closePositions?: boolean | undefined;
  /** Reason for activating the kill switch. */
  reason?: string | undefined;
  /** Max retry attempts for failed cancellations (default: 3). */
  maxRetries?: number | undefined;
  /** Risk interface to notify via onCircuitBreaker. */
  riskInterface?: RiskInterface | undefined;
}

/**
 * Cancel all open orders by ID, with retry on failure.
 *
 * @param orderIds - IDs of open orders to cancel.
 * @param options - Retry configuration.
 */
export async function cancelAllOrders(
  orderIds: string[],
  options?: { maxRetries?: number | undefined } | undefined,
): Promise<CancelAllResult> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const cancelled: string[] = [];
  const failed: string[] = [];

  for (const orderId of orderIds) {
    let success = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await cancelOrder(orderId);
        success = true;
        break;
      } catch {
        // Retry until maxRetries exhausted
      }
    }
    if (success) {
      cancelled.push(orderId);
    } else {
      failed.push(orderId);
    }
  }

  return { cancelled, failed };
}

/**
 * Close all open positions via market sell orders.
 *
 * Fetches current positions from the Polymarket API and creates
 * market sell orders for each position with size > 0.
 */
export async function closeAllPositions(): Promise<CloseAllResult> {
  const positions = await fetchPositions();
  const closed: string[] = [];
  const failed: string[] = [];

  for (const pos of positions) {
    if (pos.size === 0) continue;
    try {
      await createOrder({
        marketId: pos.marketId,
        tokenId: pos.outcomeId,
        side: "sell",
        size: pos.size,
        price: pos.currentPrice,
        orderType: "market",
      });
      closed.push(pos.outcomeId);
    } catch {
      failed.push(pos.outcomeId);
    }
  }

  return { closed, failed };
}

/**
 * Activate the kill switch: cancel all orders, optionally close
 * positions, and trigger circuit breaker on the risk interface.
 *
 * @param orderIds - IDs of open orders to cancel.
 * @param options - Kill switch configuration.
 */
export async function activateKillSwitch(
  orderIds: string[],
  options?: KillSwitchOptions | undefined,
): Promise<KillSwitchResult> {
  const cancelResult = await cancelAllOrders(orderIds, {
    maxRetries: options?.maxRetries,
  });

  let closeResult: CloseAllResult | null = null;
  if (options?.closePositions === true) {
    closeResult = await closeAllPositions();
  }

  let circuitBreakerTriggered = false;
  if (options?.riskInterface) {
    options.riskInterface.onCircuitBreaker(options.reason ?? "Kill switch activated");
    circuitBreakerTriggered = true;
  }

  return { cancelResult, closeResult, circuitBreakerTriggered };
}
