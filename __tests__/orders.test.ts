import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  createOrder as CreateOrderFn,
  cancelOrder as CancelOrderFn,
  buildOrder as BuildOrderFn,
  OrderParams,
} from "../client-polymarket.js";

const mockCallSidecar = vi.fn();
const mockCreateOrder = mockCallSidecar;
const mockCancelOrder = mockCallSidecar;
const mockBuildOrder = mockCallSidecar;

vi.mock("../sidecar.js", () => ({
  callSidecar: mockCallSidecar,
}));

let createOrder: typeof CreateOrderFn;
let cancelOrder: typeof CancelOrderFn;
let buildOrder: typeof BuildOrderFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env["WALLET_PRIVATE_KEY"] = "0xtest";
  const mod = await import("../client-polymarket.js");
  createOrder = mod.createOrder;
  cancelOrder = mod.cancelOrder;
  buildOrder = mod.buildOrder;
});

afterEach(() => {
  delete process.env["WALLET_PRIVATE_KEY"];
});

function validParams(
  overrides?: Partial<OrderParams>,
): OrderParams {
  return {
    marketId: "market-abc",
    tokenId: "token-xyz",
    side: "buy",
    size: 10,
    price: 0.55,
    orderType: "limit",
    ...overrides,
  };
}

const MOCK_ORDER = {
  id: "order-001",
  marketId: "market-abc",
  outcomeId: "token-xyz",
  side: "buy",
  type: "limit",
  amount: 10,
  price: 0.55,
  status: "open",
  filled: 0,
  remaining: 10,
};

const MOCK_BUILT_ORDER = {
  exchange: "polymarket",
  params: {
    marketId: "market-abc",
    outcomeId: "token-xyz",
    side: "buy",
    type: "limit",
    amount: 10,
    price: 0.55,
  },
  signedOrder: { sig: "0xdeadbeef" },
  raw: { nativePayload: true },
};

// ---------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------
describe("createOrder", () => {
  it("returns a well-shaped order on success", async () => {
    mockCreateOrder.mockResolvedValueOnce(MOCK_ORDER);

    const result = await createOrder(validParams());

    expect(result).toMatchObject({
      id: "order-001",
      status: "open",
      side: "buy",
      amount: 10,
      filled: 0,
      remaining: 10,
      price: 0.55,
    });
    expect(mockCreateOrder).toHaveBeenCalledOnce();
  });

  it("rejects price below 0", async () => {
    await expect(
      createOrder(validParams({ price: -0.1 })),
    ).rejects.toThrow(/price/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("rejects price above 1", async () => {
    await expect(
      createOrder(validParams({ price: 1.01 })),
    ).rejects.toThrow(/price/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("rejects zero size", async () => {
    await expect(
      createOrder(validParams({ size: 0 })),
    ).rejects.toThrow(/size/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("rejects negative size", async () => {
    await expect(
      createOrder(validParams({ size: -5 })),
    ).rejects.toThrow(/size/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("propagates insufficient balance error", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Insufficient balance for order"),
    );

    await expect(
      createOrder(validParams()),
    ).rejects.toThrow(/insufficient balance/i);
  });

  it("propagates exchange-level invalid price error", async () => {
    mockCreateOrder.mockRejectedValueOnce(
      new Error("Invalid price: outside allowed range"),
    );

    await expect(
      createOrder(validParams()),
    ).rejects.toThrow(/invalid price/i);
  });

  it("rejects invalid side", async () => {
    await expect(
      createOrder(
        validParams({ side: "hold" as "buy" }),
      ),
    ).rejects.toThrow(/side/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("rejects invalid orderType", async () => {
    await expect(
      createOrder(
        validParams({ orderType: "stop" as "limit" }),
      ),
    ).rejects.toThrow(/orderType/i);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cancelOrder
// ---------------------------------------------------------------------------
describe("cancelOrder", () => {
  it("returns cancelled order on success", async () => {
    mockCancelOrder.mockResolvedValueOnce({
      ...MOCK_ORDER,
      status: "cancelled",
    });

    const result = await cancelOrder("order-001");

    expect(result).toMatchObject({
      id: "order-001",
      status: "cancelled",
    });
    expect(mockCancelOrder).toHaveBeenCalledWith(
      "cancelOrder",
      ["order-001"],
      expect.objectContaining({ privateKey: "0xtest" }),
    );
  });

  it("propagates error for unknown order", async () => {
    mockCancelOrder.mockRejectedValueOnce(
      new Error("Order not found: bad-id"),
    );

    await expect(cancelOrder("bad-id")).rejects.toThrow(
      /order not found/i,
    );
  });
});

// ---------------------------------------------------------------------------
// buildOrder
// ---------------------------------------------------------------------------
describe("buildOrder", () => {
  it("returns built order payload without submitting", async () => {
    mockBuildOrder.mockResolvedValueOnce(MOCK_BUILT_ORDER);

    const result = await buildOrder(validParams());

    expect(result).toMatchObject({
      exchange: "polymarket",
      params: expect.objectContaining({ side: "buy" }),
    });
    expect(result.signedOrder).toBeDefined();
    expect(mockBuildOrder).toHaveBeenCalledOnce();
    expect(mockBuildOrder).toHaveBeenCalledWith(
      "buildOrder",
      expect.any(Array),
      expect.objectContaining({ privateKey: "0xtest" }),
    );
  });

  it("validates price same as createOrder", async () => {
    await expect(
      buildOrder(validParams({ price: 2.0 })),
    ).rejects.toThrow(/price/i);
    expect(mockBuildOrder).not.toHaveBeenCalled();
  });

  it("rejects zero size", async () => {
    await expect(
      buildOrder(validParams({ size: 0 })),
    ).rejects.toThrow(/size/i);
    expect(mockBuildOrder).not.toHaveBeenCalled();
  });
});
