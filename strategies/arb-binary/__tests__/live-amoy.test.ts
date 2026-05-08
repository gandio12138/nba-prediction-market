/**
 * Opt-in live smoke test for the ARB-01 `--live` wiring.
 *
 * This file is gated by `CANON_LIVE_TEST=1` so the regular unit-test
 * pipeline never picks it up. Set the env var (and the Polymarket /
 * Polygon credentials below) to exercise the seams that close
 * Q-3 / Q-4 / Q-5 in `docs/reviews/261-open-questions.md`:
 *
 *   - Q-3 — `createUsdcAllowanceClient.getAllowance()` returns a
 *     real `bigint` from a live Polygon RPC.
 *   - Q-4 — the running pmxt sidecar advertises `supportsTif: true`
 *     via `getCapabilities()`.
 *   - Q-5 — `assertLiveCapabilities()` resolves cleanly when the
 *     sidecar honours FOK and rejects with a Q-5-anchored error
 *     message when it does not.
 *
 * Q-2 (win = both legs filled in the same cycle) is closed by
 * `entry.test.ts` — covered there with deterministic mocks.
 *
 * Required to exercise Q-3 (allowance):
 *   - A canon wallet at `.canon/wallet.env` (run `canon-cli wallet ensure`)
 * Optional:
 *   - POLYGON_RPC_URL — defaults to https://polygon.drpc.org
 */

import { describe, it, expect } from "vitest";

import { getCapabilities } from "../../../client-polymarket.js";
import {
  DEFAULT_ALLOWANCE_SPENDER,
  USDC_E_ADDRESS,
} from "../../../polygon-addresses.js";
import { createUsdcAllowanceClient } from "../../../usdc-allowance.js";
import { FileWalletStore } from "../../../wallet-store.js";
import { assertLiveCapabilities } from "../entry.js";

const LIVE_ENABLED = process.env["CANON_LIVE_TEST"] === "1";
const HAS_WALLET = LIVE_ENABLED
  ? (() => {
      try {
        return new FileWalletStore().hasWallet();
      } catch {
        return false;
      }
    })()
  : false;
const RPC_URL =
  process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";

describe.runIf(LIVE_ENABLED)("ARB-01 live smoke (CANON_LIVE_TEST=1)", () => {
  describe("Q-4 / Q-5 — sidecar capabilities + start-up gate", () => {
    it("getCapabilities() reports supportsTif from the running sidecar", async () => {
      const caps = await getCapabilities();
      expect(typeof caps.supportsTif).toBe("boolean");
      // Q-4: the sidecar shipped on this branch must advertise FOK.
      // If this fails, the sidecar build is older than the patch in
      // canon/templates/sidecar.ts — rebuild before going live.
      expect(caps.supportsTif).toBe(true);
    }, 30_000);

    it("assertLiveCapabilities() resolves when FOK is supported", async () => {
      await expect(assertLiveCapabilities()).resolves.toBeUndefined();
    }, 30_000);
  });

  describe.runIf(HAS_WALLET)(
    "Q-3 — USDC allowance adapter against a live RPC",
    () => {
      it("getAllowance() returns a non-negative bigint", async () => {
        const wallet = new FileWalletStore();
        const ownerAddress = await wallet.getAddress();

        const client = createUsdcAllowanceClient({
          ownerAddress,
          spenderAddress: DEFAULT_ALLOWANCE_SPENDER,
          usdcAddress: USDC_E_ADDRESS,
          getProvider: async () => {
            const { providers } = await import("ethers");
            return new providers.JsonRpcProvider(RPC_URL);
          },
          getSigner: async () => {
            const { Wallet, providers } = await import("ethers");
            return new Wallet(
              wallet.getPrivateKey(),
              new providers.JsonRpcProvider(RPC_URL),
            );
          },
        });

        const allowance = await client.getAllowance();
        expect(typeof allowance).toBe("bigint");
        expect(allowance >= 0n).toBe(true);
      }, 60_000);
    },
  );
});
