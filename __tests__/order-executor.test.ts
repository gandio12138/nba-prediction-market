import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import type { TradeSignal } from "../types/TradeSignal.js";
import type { OrderParams, OrderResponse } from "../client-polymarket.js";
import type {
  TokenIds,
  SubmitResult,
  TrackResult,
  OrderExecutorConfig,
} from "../order-executor.js";

type FetchStatusFn = (orderId: string) => Promise<OrderResponse>;

// ---------------------------------------------------------------------------
// Mocks — client-polymarket (for submitOrder tests)
// ---------------------------------------------------------------------------

const mockCreateOrder = vi.fn();

vi.mock("../client-polymarket.js", () => ({
  createOrder: mockCreateOrder,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (re-imported per test for fresh module state)
// ---------------------------------------------------------------------------

type SignalToOrderParamsFn = (
  signal: TradeSignal,
  tokenIds: TokenIds,
  price: number,
) => OrderParams;

type SubmitOrderFn = (
  signal: TradeSignal,
  tokenIds: TokenIds,
  price: number,
) => Promise<SubmitResult>;

type TrackOrderFn = (
  orderId: string,
  fetchStatus: (orderId: string) => Promise<OrderResponse>,
  config?: Partial<OrderExecutorConfig>,
) => Promise<TrackResult>;

let signalToOrderParams: SignalToOrderParamsFn;
let submitOrder: SubmitOrderFn;
let trackOrder: TrackOrderFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../order-executor.js");
  signalToOrderParams = mod.signalToOrderParams;
  submitOrder = mod.submitOrder;
  trackOrder = mod.trackOrder;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TOKEN_IDS: TokenIds = {
  yes: "token-yes-001",
  no: "token-no-001",
};

function makeSignal(
  overrides?: Partial<TradeSignal>,
): TradeSignal {
  return {
    automation_id: "test-auto-001",
    timestamp: new Date("2026-04-14T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "market-abc",
      question: "Will it happen?",
    },
    direction: "buy_yes",
    size: 10,
    confidence: 0.8,
    urgency: "normal",
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
    type: "limit",
    amount: 10,
    price: 0.55,
    status: "open",
    filled: 0,
    remaining: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// signalToOrderParams — direction mapping
// ---------------------------------------------------------------------------

describe("signalToOrderParams", () => {
  it("maps buy_yes to buy side with yes token", () => {
    const params = signalToOrderParams(
      makeSignal({ direction: "buy_yes" }),
      TOKEN_IDS,
      0.55,
    );
    expect(params.side).toBe("buy");
    expect(params.tokenId).toBe("token-yes-001");
  });

  it("maps buy_no to buy side with no token", () => {
    const params = signalToOrderParams(
      makeSignal({ direction: "buy_no" }),
      TOKEN_IDS,
      0.45,
    );
    expect(params.side).toBe("buy");
    expect(params.tokenId).toBe("token-no-001");
  });

  it("maps sell_yes to sell side with yes token", () => {
    const params = signalToOrderParams(
      makeSignal({ direction: "sell_yes" }),
      TOKEN_IDS,
      0.60,
    );
    expect(params.side).toBe("sell");
    expect(params.tokenId).toBe("token-yes-001");
  });

  it("maps sell_no to sell side with no token", () => {
    const params = signalToOrderParams(
      makeSignal({ direction: "sell_no" }),
      TOKEN_IDS,
      0.40,
    );
    expect(params.side).toBe("sell");
    expect(params.tokenId).toBe("token-no-001");
  });

  it("maps immediate urgency to market orderType", () => {
    const params = signalToOrderParams(
      makeSignal({ urgency: "immediate" }),
      TOKEN_IDS,
      0.55,
    );
    expect(params.orderType).toBe("market");
  });

  it("maps normal urgency to limit orderType", () => {
    const params = signalToOrderParams(
      makeSignal({ urgency: "normal" }),
      TOKEN_IDS,
      0.55,
    );
    expect(params.orderType).toBe("limit");
  });

  it("maps opportunistic urgency to limit orderType", () => {
    const params = signalToOrderParams(
      makeSignal({ urgency: "opportunistic" }),
      TOKEN_IDS,
      0.55,
    );
    expect(params.orderType).toBe("limit");
  });

  it("sets marketId from signal market.market_id", () => {
    const signal = makeSignal();
    signal.market.market_id = "custom-market-42";
    const params = signalToOrderParams(signal, TOKEN_IDS, 0.55);
    expect(params.marketId).toBe("custom-market-42");
  });

  it("passes through size from signal", () => {
    const params = signalToOrderParams(
      makeSignal({ size: 25 }),
      TOKEN_IDS,
      0.55,
    );
    expect(params.size).toBe(25);
  });

  it("sets price from the provided argument", () => {
    const params = signalToOrderParams(
      makeSignal(),
      TOKEN_IDS,
      0.73,
    );
    expect(params.price).toBe(0.73);
  });
});

// ---------------------------------------------------------------------------
// signalToOrderParams — price/size validation
// ---------------------------------------------------------------------------

describe("signalToOrderParams validation", () => {
  it("rejects price below 0", () => {
    expect(() =>
      signalToOrderParams(makeSignal(), TOKEN_IDS, -0.1),
    ).toThrow(/price/i);
  });

  it("rejects price above 1", () => {
    expect(() =>
      signalToOrderParams(makeSignal(), TOKEN_IDS, 1.01),
    ).toThrow(/price/i);
  });

  it("rejects zero size", () => {
    expect(() =>
      signalToOrderParams(makeSignal({ size: 0 }), TOKEN_IDS, 0.55),
    ).toThrow(/size/i);
  });

  it("rejects negative size", () => {
    expect(() =>
      signalToOrderParams(makeSignal({ size: -5 }), TOKEN_IDS, 0.55),
    ).toThrow(/size/i);
  });
});

// ---------------------------------------------------------------------------
// submitOrder — submit flow with mocked client
// ---------------------------------------------------------------------------

describe("submitOrder", () => {
  it("calls createOrder with converted params", async () => {
    mockCreateOrder.mockResolvedValueOnce(makeOrderResponse());

    await submitOrder(makeSignal(), TOKEN_IDS, 0.55);

    expect(mockCreateOrder).toHaveBeenCalledOnce();
    const calledWith = mockCreateOrder.mock.calls[0]![0] as OrderParams;
    expect(calledWith.marketId).toBe("market-abc");
    expect(calledWith.tokenId).toBe("token-yes-001");
    expect(calledWith.side).toBe("buy");
    expect(calledWith.size).toBe(10);
    expect(calledWith.price).toBe(0.55);
    expect(calledWith.orderType).toBe("limit");
  });

  it("returns SubmitResult with open status", async () => {
    mockCreateOrder.mockResolvedValueOnce(makeOrderResponse());

    const result = await submitOrder(makeSignal(), TOKEN_IDS, 0.55);

    expect(result.orderId).toBe("order-001");
    expect(result.status).toBe("open");
    expect(result.filled).toBe(0);
    expect(result.remaining).toBe(10);
    expect(result.submittedAt).toBeInstanceOf(Date);
  });

  it("propagates auth error from createOrder", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Authentication failed: invalid API key"),
    );

    await expect(
      submitOrder(makeSignal(), TOKEN_IDS, 0.55),
    ).rejects.toThrow(/authentication failed/i);
  });

  it("propagates insufficient balance error", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Insufficient balance for order"),
    );

    await expect(
      submitOrder(makeSignal(), TOKEN_IDS, 0.55),
    ).rejects.toThrow(/insufficient balance/i);
  });

  it("propagates rate limit error", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Rate limit exceeded: retry after 60s"),
    );

    await expect(
      submitOrder(makeSignal(), TOKEN_IDS, 0.55),
    ).rejects.toThrow(/rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// trackOrder — lifecycle polling
// ---------------------------------------------------------------------------

describe("trackOrder", () => {
  let mockFetchStatus: Mock<FetchStatusFn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchStatus = vi.fn<FetchStatusFn>();
  });

  it("resolves when order transitions open → filled", async () => {
    mockFetchStatus
      .mockResolvedValueOnce(makeOrderResponse({ status: "open" }))
      .mockResolvedValueOnce(
        makeOrderResponse({
          status: "filled",
          filled: 10,
          remaining: 0,
        }),
      );

    const promise = trackOrder("order-001", mockFetchStatus, {
      pollIntervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe("filled");
    expect(result.filled).toBe(10);
    expect(result.remaining).toBe(0);
    expect(mockFetchStatus).toHaveBeenCalledTimes(2);
  });

  it("resolves when order is cancelled", async () => {
    mockFetchStatus
      .mockResolvedValueOnce(makeOrderResponse({ status: "open" }))
      .mockResolvedValueOnce(
        makeOrderResponse({
          status: "cancelled",
          filled: 0,
          remaining: 10,
        }),
      );

    const promise = trackOrder("order-001", mockFetchStatus, {
      pollIntervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe("cancelled");
    expect(mockFetchStatus).toHaveBeenCalledTimes(2);
  });

  it("tracks through partial fill to filled", async () => {
    mockFetchStatus
      .mockResolvedValueOnce(
        makeOrderResponse({
          status: "open",
          filled: 0,
          remaining: 10,
        }),
      )
      .mockResolvedValueOnce(
        makeOrderResponse({
          status: "partial_fill",
          filled: 5,
          remaining: 5,
        }),
      )
      .mockResolvedValueOnce(
        makeOrderResponse({
          status: "filled",
          filled: 10,
          remaining: 0,
        }),
      );

    const promise = trackOrder("order-001", mockFetchStatus, {
      pollIntervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe("filled");
    expect(result.filled).toBe(10);
    expect(mockFetchStatus).toHaveBeenCalledTimes(3);
  });

  it("returns timeout when order stays open past timeoutMs", async () => {
    mockFetchStatus.mockResolvedValue(
      makeOrderResponse({ status: "open" }),
    );

    const promise = trackOrder("order-001", mockFetchStatus, {
      pollIntervalMs: 5000,
      timeoutMs: 15000,
    });

    await vi.advanceTimersByTimeAsync(20000);

    const result = await promise;
    expect(result.status).toBe("timeout");
  });

  it("returns correct filled and remaining on terminal state", async () => {
    mockFetchStatus.mockResolvedValueOnce(
      makeOrderResponse({
        status: "filled",
        filled: 7,
        remaining: 3,
      }),
    );

    const promise = trackOrder("order-001", mockFetchStatus, {
      pollIntervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result.filled).toBe(7);
    expect(result.remaining).toBe(3);
    expect(result.orderId).toBe("order-001");
  });

  it("passes orderId to fetchStatus on each poll", async () => {
    mockFetchStatus.mockResolvedValueOnce(
      makeOrderResponse({
        status: "filled",
        filled: 10,
        remaining: 0,
      }),
    );

    const promise = trackOrder("order-099", mockFetchStatus, {
      pollIntervalMs: 5000,
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(mockFetchStatus).toHaveBeenCalledWith("order-099");
  });
});
