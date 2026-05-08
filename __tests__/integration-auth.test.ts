/**
 * Integration tests for auth-required Polymarket client methods.
 *
 * These tests hit the real Polymarket mainnet API. They are skipped
 * when WALLET_PRIVATE_KEY is not set (CI-safe).
 *
 * The createOrder+cancelOrder roundtrip uses a $0.01 limit buy at
 * price 0.01 — an extreme price that will never fill. The order is
 * cancelled immediately after creation.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Polymarket } from "pmxtjs";
import {
  fetchPositions,
  fetchBalance,
  fetchMyTrades,
  buildOrder,
  createOrder,
  cancelOrder,
} from "../client-polymarket.js";
import type { OrderParams } from "../client-polymarket.js";

const HAS_AUTH = Boolean(process.env["WALLET_PRIVATE_KEY"]);

describe.runIf(HAS_AUTH)(
  "integration: auth-required methods",
  () => {
    let testMarketId: string;
    let testTokenId: string;

    beforeAll(async () => {
      // Use pmxtjs directly to discover a liquid market with a known
      // outcomeId (tokenId). Our wrapper searchMarkets doesn't expose
      // outcome IDs, so we need the SDK for test setup.
      const poly = new Polymarket({ autoStartServer: true });
      const markets = await poly.fetchMarkets({ limit: 20 });
      const sorted = [...markets].sort(
        (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0),
      );

      for (const m of sorted) {
        const oid = m.outcomes[0]?.outcomeId;
        if (oid && m.marketId) {
          testMarketId = m.marketId;
          testTokenId = oid;
          break;
        }
      }

      if (!testMarketId || !testTokenId) {
        throw new Error(
          "No liquid market found for integration tests",
        );
      }
    }, 30_000);

    // -----------------------------------------------------------------
    // fetchPositions
    // -----------------------------------------------------------------
    it("fetchPositions returns an array of positions", async () => {
      const positions = await fetchPositions();

      expect(Array.isArray(positions)).toBe(true);
      for (const p of positions) {
        expect(typeof p.marketId).toBe("string");
        expect(typeof p.outcomeId).toBe("string");
        expect(typeof p.outcomeLabel).toBe("string");
        expect(typeof p.size).toBe("number");
        expect(typeof p.entryPrice).toBe("number");
        expect(typeof p.currentPrice).toBe("number");
        expect(typeof p.unrealizedPnL).toBe("number");
      }
    }, 15_000);

    // -----------------------------------------------------------------
    // fetchBalance
    // -----------------------------------------------------------------
    it("fetchBalance returns balance array with USDC", async () => {
      const balances = await fetchBalance();

      expect(Array.isArray(balances)).toBe(true);
      expect(balances.length).toBeGreaterThanOrEqual(1);

      const usdc = balances.find((b) => b.currency === "USDC");
      expect(usdc).toBeDefined();
      expect(typeof usdc!.total).toBe("number");
      expect(typeof usdc!.available).toBe("number");
      expect(typeof usdc!.locked).toBe("number");
    }, 15_000);

    // -----------------------------------------------------------------
    // fetchMyTrades
    // -----------------------------------------------------------------
    it("fetchMyTrades returns an array of trades", async () => {
      const trades = await fetchMyTrades();

      expect(Array.isArray(trades)).toBe(true);
      for (const t of trades) {
        expect(typeof t.id).toBe("string");
        expect(typeof t.price).toBe("number");
        expect(typeof t.amount).toBe("number");
        expect(typeof t.side).toBe("string");
        expect(typeof t.timestamp).toBe("number");
      }
    }, 15_000);

    // -----------------------------------------------------------------
    // buildOrder
    // -----------------------------------------------------------------
    it("buildOrder returns a dry-run payload", async () => {
      const params: OrderParams = {
        marketId: testMarketId,
        tokenId: testTokenId,
        side: "buy",
        size: 200,
        price: 0.01,
        orderType: "limit",
      };

      const result = await buildOrder(params);

      expect(typeof result.exchange).toBe("string");
      expect(result.params.marketId).toBe(testMarketId);
      expect(result.params.outcomeId).toBe(testTokenId);
      expect(result.params.side).toBe("buy");
      expect(result.params.type).toBe("limit");
      expect(result.params.amount).toBe(200);
      expect(result.params.price).toBe(0.01);
    }, 15_000);

    // -----------------------------------------------------------------
    // createOrder + cancelOrder roundtrip
    // -----------------------------------------------------------------
    it(
      "createOrder + cancelOrder roundtrip with never-fill order",
      async () => {
        const params: OrderParams = {
          marketId: testMarketId,
          tokenId: testTokenId,
          side: "buy",
          size: 200,
          price: 0.01,
          orderType: "limit",
        };

        // Create a limit order at $0.01 — will never fill
        const created = await createOrder(params);

        expect(typeof created.id).toBe("string");
        expect(created.id.length).toBeGreaterThan(0);
        expect(created.marketId).toBe(testMarketId);
        expect(created.outcomeId).toBe(testTokenId);
        expect(created.side).toBe("buy");
        expect(created.type).toBe("limit");
        expect(created.amount).toBe(200);
        expect(created.filled).toBe(0);
        expect(created.remaining).toBe(200);

        // Cancel immediately
        const cancelled = await cancelOrder(created.id);

        expect(cancelled.id).toBe(created.id);
        expect(cancelled.status).toBe("cancelled");
      },
      30_000,
    );
  },
);
