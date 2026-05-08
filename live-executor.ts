/**
 * Live executor — converts TradeSignals into real Polymarket CLOB orders.
 *
 * Wraps `order-executor.signalToOrderParams` + `client-polymarket.createOrder`
 * with a generic `resolveOrder` hook (for strategy-specific token-id / price
 * resolution) and an idempotent USDC allowance check. Designed to be reused
 * by `arb-binary`, `mint-01`, `mint-05`, and `arb-02`.
 */

import { cancelOrder, createOrder } from "./client-polymarket.js";
import type { CancelResult, TimeInForce } from "./client-polymarket.js";
import { signalToOrderParams } from "./order-executor.js";
import type { TokenIds } from "./order-executor.js";
import type { TradeSignal } from "./types/TradeSignal.js";

/** Resolved per-signal order details supplied by the calling strategy. */
export interface ResolvedOrder {
  tokenIds: TokenIds;
  price: number;
  /**
   * Optional time-in-force override forwarded to the exchange.
   * ARB-01 uses "FOK" to prevent one-sided leg fills.
   */
  timeInForce?: TimeInForce;
}

/** Strategy hook that translates a signal into token IDs and a target price. */
export type ResolveOrder = (signal: TradeSignal) => ResolvedOrder;

/** USDC allowance manager for the CTFExchange. */
export interface AllowanceClient {
  /** Read current USDC allowance for the exchange (raw 6-decimal units). */
  getAllowance(): Promise<bigint>;
  /** Approve a new allowance amount (raw 6-decimal units). */
  approve(amount: bigint): Promise<{ txHash: string }>;
}

/** Options accepted by `createLiveExecutor`. */
export interface LiveExecutorOptions {
  resolveOrder: ResolveOrder;
  allowance?: AllowanceClient;
  /** When current allowance < threshold, top up to `allowanceTarget`. */
  allowanceThreshold?: bigint;
  allowanceTarget?: bigint;
}

/** Result of `submit()` — the minimal id/status pair callers need. */
export interface SubmitOutcome {
  id: string;
  status: string;
}

/** Live executor public surface. */
export interface LiveExecutor {
  submit(signal: TradeSignal): Promise<SubmitOutcome>;
  cancel(orderId: string): Promise<CancelResult>;
  /** IDs of every successfully submitted order, in submission order. */
  readonly submittedOrderIds: string[];
}

/**
 * Build a live executor that places real CLOB orders.
 *
 * Allowance handling is idempotent: `getAllowance` is consulted lazily; once
 * the cached allowance is at or above `allowanceThreshold`, no further reads
 * or approvals occur. The boundary is strict — at exactly the threshold no
 * `approve()` is sent.
 */
export function createLiveExecutor(opts: LiveExecutorOptions): LiveExecutor {
  const submittedOrderIds: string[] = [];
  const allowance = opts.allowance;
  const threshold = opts.allowanceThreshold;
  const target = opts.allowanceTarget;
  let cachedAllowance: bigint | undefined;

  async function ensureAllowance(): Promise<void> {
    if (!allowance || threshold === undefined || target === undefined) return;
    if (cachedAllowance !== undefined && cachedAllowance >= threshold) return;

    if (cachedAllowance === undefined) {
      cachedAllowance = await allowance.getAllowance();
    }
    if (cachedAllowance < threshold) {
      await allowance.approve(target);
      cachedAllowance = target;
    }
  }

  async function submit(signal: TradeSignal): Promise<SubmitOutcome> {
    await ensureAllowance();

    const { tokenIds, price, timeInForce } = opts.resolveOrder(signal);
    const params = signalToOrderParams(signal, tokenIds, price, timeInForce);

    const response = await createOrder(params);
    submittedOrderIds.push(response.id);
    return { id: response.id, status: response.status };
  }

  async function cancel(orderId: string): Promise<CancelResult> {
    return cancelOrder(orderId);
  }

  return {
    submit,
    cancel,
    get submittedOrderIds() {
      return submittedOrderIds;
    },
  };
}
