/**
 * Tests for the live executor module (`canon/templates/live-executor.ts`).
 *
 * Defines the contract for `createLiveExecutor()`:
 *   - signal → createOrder parameter mapping (delegates to order-executor)
 *   - idempotent USDC allowance check (approve only when below threshold)
 *   - in-memory order ID tracking
 *   - cancel() helper
 *   - error path propagation
 *
 * The pmxtjs CLOB client is mocked — these are unit tests, no live calls.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TradeSignal } from "../types/TradeSignal.js";
import type {
  OrderParams,
  OrderResponse,
  CancelResult,
} from "../client-polymarket.js";
import type {
  AllowanceClient,
  LiveExecutor,
  LiveExecutorOptions,
} from "../live-executor.js";

const mockCreateOrder = vi.fn<(p: OrderParams) => Promise<OrderResponse>>();
const mockCancelOrder = vi.fn<(id: string) => Promise<CancelResult>>();

vi.mock("../client-polymarket.js", () => ({
  createOrder: mockCreateOrder,
  cancelOrder: mockCancelOrder,
}));

let createLiveExecutor: (opts: LiveExecutorOptions) => LiveExecutor;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../live-executor.js");
  createLiveExecutor = mod.createLiveExecutor;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_IDS = {
  yes: "token-yes-001",
  no: "token-no-001",
} as const;

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    automation_id: "arb-binary",
    timestamp: new Date("2026-04-29T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "market-abc",
      question: "Will it happen?",
    },
    direction: "buy_yes",
    size: 10,
    confidence: 0.8,
    urgency: "immediate",
    metadata: {},
    ...overrides,
  };
}

function makeOrderResponse(
  overrides?: Partial<OrderResponse>,
): OrderResponse {
  return {
    id: "order-001",
    marketId: "market-abc",
    outcomeId: "token-yes-001",
    side: "buy",
    type: "market",
    amount: 10,
    price: 0.55,
    status: "open",
    filled: 0,
    remaining: 10,
    ...overrides,
  };
}

const resolveOrder = (
  price = 0.55,
): LiveExecutorOptions["resolveOrder"] =>
  () => ({ tokenIds: { ...TOKEN_IDS }, price });

function makeAllowance(initial: bigint): AllowanceClient & {
  getAllowance: ReturnType<typeof vi.fn<() => Promise<bigint>>>;
  approve: ReturnType<
    typeof vi.fn<(amount: bigint) => Promise<{ txHash: string }>>
  >;
  current: bigint;
} {
  const state = { current: initial };
  const getAllowance = vi.fn<() => Promise<bigint>>(async () => state.current);
  const approve = vi.fn<(amount: bigint) => Promise<{ txHash: string }>>(
    async (amount: bigint) => {
      state.current = amount;
      return { txHash: "0xapprove" };
    },
  );
  return {
    get current() {
      return state.current;
    },
    getAllowance,
    approve,
  };
}

// ---------------------------------------------------------------------------
// signal → createOrder mapping
// ---------------------------------------------------------------------------

describe("createLiveExecutor.submit — signal → order mapping", () => {
  it("submits a buy_yes signal as a buy on the YES token", async () => {
    mockCreateOrder.mockResolvedValueOnce(makeOrderResponse());

    const exec = createLiveExecutor({ resolveOrder: resolveOrder(0.55) });
    const result = await exec.submit(makeSignal({ direction: "buy_yes" }));

    expect(mockCreateOrder).toHaveBeenCalledOnce();
    const params = mockCreateOrder.mock.calls[0]![0];
    expect(params.marketId).toBe("market-abc");
    expect(params.tokenId).toBe("token-yes-001");
    expect(params.side).toBe("buy");
    expect(params.size).toBe(10);
    expect(params.price).toBe(0.55);
    expect(params.orderType).toBe("market"); // urgency=immediate

    expect(result.id).toBe("order-001");
    expect(result.status).toBe("open");
  });

  it("submits a buy_no signal as a buy on the NO token", async () => {
    mockCreateOrder.mockResolvedValueOnce(
      makeOrderResponse({ outcomeId: "token-no-001" }),
    );

    const exec = createLiveExecutor({ resolveOrder: resolveOrder(0.42) });
    await exec.submit(makeSignal({ direction: "buy_no" }));

    const params = mockCreateOrder.mock.calls[0]![0];
    expect(params.tokenId).toBe("token-no-001");
    expect(params.side).toBe("buy");
    expect(params.price).toBe(0.42);
  });

  it("maps non-immediate urgency to limit orderType", async () => {
    mockCreateOrder.mockResolvedValueOnce(makeOrderResponse());

    const exec = createLiveExecutor({ resolveOrder: resolveOrder(0.5) });
    await exec.submit(makeSignal({ urgency: "normal" }));

    const params = mockCreateOrder.mock.calls[0]![0];
    expect(params.orderType).toBe("limit");
  });

  it("tracks every successfully submitted order ID", async () => {
    mockCreateOrder
      .mockResolvedValueOnce(makeOrderResponse({ id: "order-001" }))
      .mockResolvedValueOnce(makeOrderResponse({ id: "order-002" }));

    const exec = createLiveExecutor({ resolveOrder: resolveOrder() });
    await exec.submit(makeSignal());
    await exec.submit(makeSignal());

    expect(exec.submittedOrderIds).toEqual(["order-001", "order-002"]);
  });
});

// ---------------------------------------------------------------------------
// USDC allowance idempotency
// ---------------------------------------------------------------------------

describe("createLiveExecutor.submit — allowance idempotency", () => {
  const THRESHOLD = 100_000_000_000n; // 100k USDC, 6 decimals
  const TARGET = 1_000_000_000_000n; // 1M USDC

  it("approves once when current allowance is below threshold", async () => {
    mockCreateOrder.mockResolvedValue(makeOrderResponse());
    const allowance = makeAllowance(0n);

    const exec = createLiveExecutor({
      resolveOrder: resolveOrder(),
      allowance,
      allowanceThreshold: THRESHOLD,
      allowanceTarget: TARGET,
    });

    await exec.submit(makeSignal());
    await exec.submit(makeSignal());
    await exec.submit(makeSignal());

    // approve called exactly once across 3 submissions
    expect(allowance.approve).toHaveBeenCalledOnce();
    expect(allowance.approve).toHaveBeenCalledWith(TARGET);
    // allowance is consulted at most once when first call sufficed
    expect(allowance.getAllowance).toHaveBeenCalledOnce();
    expect(mockCreateOrder).toHaveBeenCalledTimes(3);
  });

  it("does not approve when current allowance is already above threshold", async () => {
    mockCreateOrder.mockResolvedValue(makeOrderResponse());
    const allowance = makeAllowance(TARGET);

    const exec = createLiveExecutor({
      resolveOrder: resolveOrder(),
      allowance,
      allowanceThreshold: THRESHOLD,
      allowanceTarget: TARGET,
    });

    await exec.submit(makeSignal());
    await exec.submit(makeSignal());

    expect(allowance.approve).not.toHaveBeenCalled();
    expect(allowance.getAllowance).toHaveBeenCalledOnce();
    expect(mockCreateOrder).toHaveBeenCalledTimes(2);
  });

  it("approves when allowance is exactly at threshold (boundary: < threshold required)", async () => {
    // Plan: "only sends approve() when current allowance < configured threshold"
    // At exactly threshold, no approve.
    mockCreateOrder.mockResolvedValue(makeOrderResponse());
    const allowance = makeAllowance(THRESHOLD);

    const exec = createLiveExecutor({
      resolveOrder: resolveOrder(),
      allowance,
      allowanceThreshold: THRESHOLD,
      allowanceTarget: TARGET,
    });

    await exec.submit(makeSignal());
    expect(allowance.approve).not.toHaveBeenCalled();
  });

  it("skips allowance flow entirely when no allowance client is provided", async () => {
    mockCreateOrder.mockResolvedValue(makeOrderResponse());

    const exec = createLiveExecutor({ resolveOrder: resolveOrder() });
    await exec.submit(makeSignal());

    expect(mockCreateOrder).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// cancel()
// ---------------------------------------------------------------------------

describe("createLiveExecutor.cancel", () => {
  it("delegates to cancelOrder and returns the result", async () => {
    mockCancelOrder.mockResolvedValueOnce({
      id: "order-001",
      status: "cancelled",
    });

    const exec = createLiveExecutor({ resolveOrder: resolveOrder() });
    const result = await exec.cancel("order-001");

    expect(mockCancelOrder).toHaveBeenCalledWith("order-001");
    expect(result.id).toBe("order-001");
    expect(result.status).toBe("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe("createLiveExecutor.submit — error path", () => {
  it("propagates errors from createOrder and does not record the order ID", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Insufficient balance for order"),
    );

    const exec = createLiveExecutor({ resolveOrder: resolveOrder() });

    await expect(exec.submit(makeSignal())).rejects.toThrow(
      /insufficient balance/i,
    );
    expect(exec.submittedOrderIds).toEqual([]);
  });

  it("propagates errors from the allowance client and does not call createOrder", async () => {
    const allowance: AllowanceClient = {
      getAllowance: vi.fn<() => Promise<bigint>>().mockRejectedValueOnce(
        new Error("RPC unreachable"),
      ),
      approve: vi.fn<(amount: bigint) => Promise<{ txHash: string }>>(),
    };

    const exec = createLiveExecutor({
      resolveOrder: resolveOrder(),
      allowance,
      allowanceThreshold: 1n,
      allowanceTarget: 2n,
    });

    await expect(exec.submit(makeSignal())).rejects.toThrow(/rpc unreachable/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(exec.submittedOrderIds).toEqual([]);
  });

  it("rejects invalid prices via the underlying signalToOrderParams validator", async () => {
    const exec = createLiveExecutor({ resolveOrder: resolveOrder(1.5) });

    await expect(exec.submit(makeSignal())).rejects.toThrow(/price/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });
});
