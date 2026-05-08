import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  fetchPositions as FetchPositionsFn,
  fetchBalance as FetchBalanceFn,
} from "../client-polymarket.js";

const mockFetchPositions = vi.fn();
const mockFetchBalance = vi.fn();

vi.mock("pmxtjs", () => {
  class MockPolymarket {
    fetchPositions = mockFetchPositions;
    fetchBalance = mockFetchBalance;
  }
  return { Polymarket: MockPolymarket };
});

let fetchPositions: typeof FetchPositionsFn;
let fetchBalance: typeof FetchBalanceFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../client-polymarket.js");
  fetchPositions = mod.fetchPositions;
  fetchBalance = mod.fetchBalance;
});

// ---------------------------------------------------------------------------
// fetchPositions
// ---------------------------------------------------------------------------
describe("fetchPositions", () => {
  it("returns typed positions on success", async () => {
    mockFetchPositions.mockResolvedValueOnce([
      {
        marketId: "0xabc",
        outcomeId: "tok-1",
        outcomeLabel: "Yes",
        size: 100,
        entryPrice: 0.45,
        currentPrice: 0.55,
        unrealizedPnL: 10,
      },
      {
        marketId: "0xdef",
        outcomeId: "tok-2",
        outcomeLabel: "No",
        size: 50,
        entryPrice: 0.6,
        currentPrice: 0.4,
        unrealizedPnL: -10,
      },
    ]);

    const result = await fetchPositions();

    expect(result).toHaveLength(2);

    const pos0 = result[0]!;
    expect(pos0.marketId).toBe("0xabc");
    expect(pos0.outcomeId).toBe("tok-1");
    expect(pos0.outcomeLabel).toBe("Yes");
    expect(pos0.size).toBe(100);
    expect(pos0.entryPrice).toBe(0.45);
    expect(pos0.currentPrice).toBe(0.55);
    expect(pos0.unrealizedPnL).toBe(10);

    const pos1 = result[1]!;
    expect(pos1.marketId).toBe("0xdef");
    expect(pos1.outcomeLabel).toBe("No");
    expect(pos1.unrealizedPnL).toBe(-10);
  });

  it("propagates auth error from pmxtjs", async () => {
    mockFetchPositions.mockRejectedValueOnce(
      new Error(
        "AuthenticationError: Trading operations require authentication. " +
          "Initialize PolymarketExchange with credentials: " +
          'new PolymarketExchange({ privateKey: "0x..." })',
      ),
    );

    await expect(fetchPositions()).rejects.toThrow("AuthenticationError");
  });

  it("returns empty array for empty portfolio", async () => {
    mockFetchPositions.mockResolvedValueOnce([]);

    const result = await fetchPositions();

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchBalance
// ---------------------------------------------------------------------------
describe("fetchBalance", () => {
  it("returns typed balances on success", async () => {
    mockFetchBalance.mockResolvedValueOnce([
      {
        currency: "USDC",
        total: 1000,
        available: 800,
        locked: 200,
      },
    ]);

    const result = await fetchBalance();

    expect(result).toHaveLength(1);

    const bal = result[0]!;
    expect(bal.currency).toBe("USDC");
    expect(bal.total).toBe(1000);
    expect(bal.available).toBe(800);
    expect(bal.locked).toBe(200);
  });

  it("propagates auth error from pmxtjs", async () => {
    mockFetchBalance.mockRejectedValueOnce(
      new Error(
        "AuthenticationError: Trading operations require authentication. " +
          "Initialize PolymarketExchange with credentials: " +
          'new PolymarketExchange({ privateKey: "0x..." })',
      ),
    );

    await expect(fetchBalance()).rejects.toThrow("AuthenticationError");
  });

  it("returns empty array for empty portfolio", async () => {
    mockFetchBalance.mockResolvedValueOnce([]);

    const result = await fetchBalance();

    expect(result).toEqual([]);
  });
});
