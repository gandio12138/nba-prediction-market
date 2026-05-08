/**
 * Order executor — converts TradeSignal → Polymarket order,
 * submits via client, and tracks lifecycle until terminal state.
 */

import type { TradeSignal } from "./types/TradeSignal.js";
import type {
  OrderParams,
  OrderResponse,
  TimeInForce,
} from "./client-polymarket.js";
import { createOrder } from "./client-polymarket.js";

/** Token IDs for the YES and NO outcomes of a binary market. */
export interface TokenIds {
  yes: string;
  no: string;
}

/** Configuration for order lifecycle tracking. */
export interface OrderExecutorConfig {
  /** Milliseconds between status polls (default: 5000). */
  pollIntervalMs: number;
  /** Maximum milliseconds to wait before declaring timeout (default: 60000). */
  timeoutMs: number;
}

/** Result of submitting an order. */
export interface SubmitResult {
  orderId: string;
  marketId: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  status: string;
  filled: number;
  remaining: number;
  submittedAt: Date;
}

/** Result of tracking an order to a terminal state. */
export interface TrackResult {
  orderId: string;
  status: "filled" | "cancelled" | "timeout";
  filled: number;
  remaining: number;
}

const DIRECTION_MAP: Record<
  TradeSignal["direction"],
  { side: "buy" | "sell"; token: "yes" | "no" }
> = {
  buy_yes: { side: "buy", token: "yes" },
  buy_no: { side: "buy", token: "no" },
  sell_yes: { side: "sell", token: "yes" },
  sell_no: { side: "sell", token: "no" },
};

const TERMINAL_STATUSES = new Set(["filled", "cancelled"]);

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Convert a TradeSignal into OrderParams for the Polymarket client.
 *
 * Direction mapping:
 * - buy_yes  → side: "buy",  tokenId: tokenIds.yes
 * - buy_no   → side: "buy",  tokenId: tokenIds.no
 * - sell_yes → side: "sell", tokenId: tokenIds.yes
 * - sell_no  → side: "sell", tokenId: tokenIds.no
 *
 * Urgency mapping:
 * - "immediate"     → orderType: "market"
 * - "normal"        → orderType: "limit"
 * - "opportunistic" → orderType: "limit"
 *
 * Validates: price in [0, 1], size > 0.
 */
export function signalToOrderParams(
  signal: TradeSignal,
  tokenIds: TokenIds,
  price: number,
  timeInForce?: TimeInForce,
): OrderParams {
  if (price < 0 || price > 1) {
    throw new Error(
      `Invalid price ${String(price)}: must be between 0 and 1`,
    );
  }
  if (signal.size <= 0) {
    throw new Error(
      `Invalid size ${String(signal.size)}: must be greater than 0`,
    );
  }

  const { side, token } = DIRECTION_MAP[signal.direction];
  const orderType: "market" | "limit" =
    signal.urgency === "immediate" && timeInForce === undefined
      ? "market"
      : "limit";

  const params: OrderParams = {
    marketId: signal.market.market_id,
    tokenId: tokenIds[token],
    side,
    size: signal.size,
    price,
    orderType,
  };
  if (timeInForce !== undefined) {
    params.timeInForce = timeInForce;
  }
  return params;
}

/**
 * Submit an order derived from a TradeSignal.
 *
 * Converts the signal via signalToOrderParams, then calls createOrder
 * from the Polymarket client.
 */
export async function submitOrder(
  signal: TradeSignal,
  tokenIds: TokenIds,
  price: number,
): Promise<SubmitResult> {
  const params = signalToOrderParams(signal, tokenIds, price);
  const response = await createOrder(params);

  return {
    orderId: response.id,
    marketId: response.marketId,
    side: params.side,
    size: params.size,
    price: params.price,
    status: response.status,
    filled: response.filled,
    remaining: response.remaining,
    submittedAt: new Date(),
  };
}

/**
 * Track an order's lifecycle by polling until a terminal state.
 *
 * Terminal states: "filled", "cancelled".
 * Returns "timeout" status if the order does not reach a terminal state
 * within config.timeoutMs milliseconds.
 *
 * @param orderId - The order ID to track.
 * @param fetchStatus - Callback to poll current order state.
 * @param config - Optional polling configuration.
 */
export async function trackOrder(
  orderId: string,
  fetchStatus: (orderId: string) => Promise<OrderResponse>,
  config?: Partial<OrderExecutorConfig>,
): Promise<TrackResult> {
  const pollIntervalMs =
    config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  for (;;) {
    const response = await fetchStatus(orderId);

    if (TERMINAL_STATUSES.has(response.status)) {
      return {
        orderId,
        status: response.status as "filled" | "cancelled",
        filled: response.filled,
        remaining: response.remaining,
      };
    }

    if (Date.now() - start >= timeoutMs) {
      return {
        orderId,
        status: "timeout",
        filled: response.filled,
        remaining: response.remaining,
      };
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    });
  }
}
