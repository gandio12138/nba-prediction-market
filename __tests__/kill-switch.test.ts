import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrderResponse, Position } from "../client-polymarket.js";

const mockCancelOrder = vi.hoisted(() => vi.fn());
const mockFetchPositions = vi.hoisted(() => vi.fn());
const mockCreateOrder = vi.hoisted(() => vi.fn());

vi.mock("../client-polymarket.js", () => ({
  cancelOrder: mockCancelOrder,
  fetchPositions: mockFetchPositions,
  createOrder: mockCreateOrder,
}));

import {
  cancelAllOrders,
  closeAllPositions,
  activateKillSwitch,
} from "../kill-switch.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockOrderResponse(
  id: string,
  status = "cancelled",
): OrderResponse {
  return {
    id,
    marketId: "market-abc",
    outcomeId: "token-xyz",
    side: "buy",
    type: "limit",
    amount: 10,
    price: 0.55,
    status,
    filled: 0,
    remaining: 10,
  };
}

function mockPosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: "market-abc",
    outcomeId: "token-xyz",
    outcomeLabel: "Yes",
    size: 10,
    entryPrice: 0.5,
    currentPrice: 0.6,
    unrealizedPnL: 1.0,
    ...overrides,
  };
}

function createMockRiskInterface() {
  return {
    preTradeCheck: vi.fn().mockReturnValue({ approved: true }),
    getExposure: vi.fn().mockReturnValue({
      total_capital_deployed: 0,
      position_count: 0,
      largest_position: 0,
      markets: [],
    }),
    onCircuitBreaker: vi.fn(),
  };
}

beforeEach(() => {
  mockCancelOrder.mockReset();
  mockFetchPositions.mockReset();
  mockCreateOrder.mockReset();
});

// ---------------------------------------------------------------------------
// cancelAllOrders
// ---------------------------------------------------------------------------

describe("cancelAllOrders", () => {
  it("cancels all orders successfully", async () => {
    mockCancelOrder
      .mockResolvedValueOnce(mockOrderResponse("order-1"))
      .mockResolvedValueOnce(mockOrderResponse("order-2"))
      .mockResolvedValueOnce(mockOrderResponse("order-3"));

    const result = await cancelAllOrders([
      "order-1",
      "order-2",
      "order-3",
    ]);

    expect(result.cancelled).toEqual(["order-1", "order-2", "order-3"]);
    expect(result.failed).toEqual([]);
    expect(mockCancelOrder).toHaveBeenCalledTimes(3);
  });

  it("returns empty result for empty order list", async () => {
    const result = await cancelAllOrders([]);

    expect(result.cancelled).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it("retries failed cancellation and succeeds on retry", async () => {
    // order-1 succeeds first try; order-2 fails once then succeeds
    mockCancelOrder
      .mockResolvedValueOnce(mockOrderResponse("order-1"))
      .mockRejectedValueOnce(new Error("Network timeout"))
      .mockResolvedValueOnce(mockOrderResponse("order-2"));

    const result = await cancelAllOrders(
      ["order-1", "order-2"],
      { maxRetries: 2 },
    );

    expect(result.cancelled).toContain("order-1");
    expect(result.cancelled).toContain("order-2");
    expect(result.failed).toEqual([]);
    // 1 (ok) + 1 (fail) + 1 (retry ok) = 3 calls
    expect(mockCancelOrder).toHaveBeenCalledTimes(3);
  });

  it("reports orders that fail after all retries exhausted", async () => {
    mockCancelOrder
      .mockResolvedValueOnce(mockOrderResponse("order-1"))
      // order-2 fails on initial + 3 retries = 4 attempts
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"));

    const result = await cancelAllOrders(
      ["order-1", "order-2"],
      { maxRetries: 3 },
    );

    expect(result.cancelled).toEqual(["order-1"]);
    expect(result.failed).toEqual(["order-2"]);
  });

  it("uses default retry count when maxRetries not specified", async () => {
    mockCancelOrder.mockRejectedValue(new Error("Persistent failure"));

    const result = await cancelAllOrders(["order-1"]);

    expect(result.failed).toEqual(["order-1"]);
    // Default: 1 initial + 3 retries = 4 total calls
    expect(mockCancelOrder).toHaveBeenCalledTimes(4);
  });

  it("calls cancelOrder with each order ID", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("any"));

    await cancelAllOrders(["order-a", "order-b"]);

    expect(mockCancelOrder).toHaveBeenCalledWith("order-a");
    expect(mockCancelOrder).toHaveBeenCalledWith("order-b");
  });
});

// ---------------------------------------------------------------------------
// closeAllPositions
// ---------------------------------------------------------------------------

describe("closeAllPositions", () => {
  it("closes all positions via market sell orders", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      mockPosition({
        marketId: "market-1",
        outcomeId: "token-1",
        size: 5,
      }),
      mockPosition({
        marketId: "market-2",
        outcomeId: "token-2",
        size: 8,
      }),
    ]);
    mockCreateOrder.mockResolvedValue(
      mockOrderResponse("sell-order", "filled"),
    );

    const result = await closeAllPositions();

    expect(result.closed).toHaveLength(2);
    expect(result.failed).toEqual([]);
    expect(mockCreateOrder).toHaveBeenCalledTimes(2);

    // Verify sell orders use correct params
    const firstCall = mockCreateOrder.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(firstCall).toMatchObject({
      tokenId: "token-1",
      side: "sell",
      orderType: "market",
    });
  });

  it("returns empty result when no positions exist", async () => {
    mockFetchPositions.mockResolvedValueOnce([]);

    const result = await closeAllPositions();

    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("handles partial close failure", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      mockPosition({
        marketId: "market-1",
        outcomeId: "token-1",
      }),
      mockPosition({
        marketId: "market-2",
        outcomeId: "token-2",
      }),
    ]);
    mockCreateOrder
      .mockResolvedValueOnce(mockOrderResponse("sell-1", "filled"))
      .mockRejectedValueOnce(new Error("Insufficient liquidity"));

    const result = await closeAllPositions();

    expect(result.closed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  it("skips zero-size positions", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      mockPosition({ marketId: "market-1", size: 10 }),
      mockPosition({ marketId: "market-2", size: 0 }),
    ]);
    mockCreateOrder.mockResolvedValue(
      mockOrderResponse("sell-order", "filled"),
    );

    const result = await closeAllPositions();

    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(result.closed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// activateKillSwitch — cancel + close + circuit breaker
// ---------------------------------------------------------------------------

describe("activateKillSwitch", () => {
  it("cancels orders and closes positions when closePositions is true", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));
    mockFetchPositions.mockResolvedValueOnce([
      mockPosition({ marketId: "market-1" }),
    ]);
    mockCreateOrder.mockResolvedValue(
      mockOrderResponse("sell-1", "filled"),
    );

    const result = await activateKillSwitch(["order-1"], {
      closePositions: true,
      reason: "Emergency shutdown",
    });

    expect(result.cancelResult.cancelled).toEqual(["order-1"]);
    expect(result.closeResult).not.toBeNull();
    expect(result.closeResult?.closed).toHaveLength(1);
  });

  it("cancel-only mode skips position closure", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));

    const result = await activateKillSwitch(["order-1"], {
      closePositions: false,
    });

    expect(result.cancelResult.cancelled).toEqual(["order-1"]);
    expect(result.closeResult).toBeNull();
    expect(mockFetchPositions).not.toHaveBeenCalled();
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("triggers circuit breaker on risk interface with reason", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));
    const risk = createMockRiskInterface();

    await activateKillSwitch(["order-1"], {
      reason: "Max drawdown exceeded",
      riskInterface: risk,
    });

    expect(risk.onCircuitBreaker).toHaveBeenCalledOnce();
    expect(risk.onCircuitBreaker).toHaveBeenCalledWith(
      "Max drawdown exceeded",
    );
  });

  it("sets circuitBreakerTriggered true when risk interface provided", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));
    const risk = createMockRiskInterface();

    const result = await activateKillSwitch(["order-1"], {
      reason: "Risk limit hit",
      riskInterface: risk,
    });

    expect(result.circuitBreakerTriggered).toBe(true);
  });

  it("sets circuitBreakerTriggered false when no risk interface", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));

    const result = await activateKillSwitch(["order-1"]);

    expect(result.circuitBreakerTriggered).toBe(false);
  });

  it("defaults closePositions to false", async () => {
    mockCancelOrder.mockResolvedValue(mockOrderResponse("order-1"));

    const result = await activateKillSwitch(["order-1"]);

    expect(result.closeResult).toBeNull();
    expect(mockFetchPositions).not.toHaveBeenCalled();
  });

  it("handles empty orders with close positions enabled", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      mockPosition({ marketId: "market-1" }),
    ]);
    mockCreateOrder.mockResolvedValue(
      mockOrderResponse("sell-1", "filled"),
    );

    const result = await activateKillSwitch([], {
      closePositions: true,
    });

    expect(result.cancelResult.cancelled).toEqual([]);
    expect(result.cancelResult.failed).toEqual([]);
    expect(result.closeResult?.closed).toHaveLength(1);
  });
});
