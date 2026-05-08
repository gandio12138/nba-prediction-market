/**
 * Tests for `canon/templates/live-preflight.ts`.
 *
 * Pins the contract every strategy's `assertLiveCapabilities` delegates
 * to. The shared helper:
 *
 *   - Throws with the strategy's name + required TIF when the sidecar
 *     does not advertise `supportsTif`.
 *   - Skips the onboarding gate when no wallet is configured (dry-run
 *     orchestrator path).
 *   - Calls `polymarketOnboard.build(pk).status()` when a wallet is
 *     configured, and surfaces every missing flag as a single
 *     concatenated error pointing at the right `canon-cli onboard`
 *     remediation.
 *   - Runs the optional `authSmoke` callback last, surfacing failures
 *     with the strategy prefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCapabilities = vi.fn();
vi.mock("../client-polymarket.js", () => ({
  getCapabilities: mockGetCapabilities,
}));

const mockOnboardStatus = vi.fn();
vi.mock("../polymarket-onboard.js", () => ({
  polymarketOnboard: {
    venue: "polymarket",
    chainId: 137,
    build: () => ({
      status: mockOnboardStatus,
      ensureFunder: vi.fn(),
      ensureApprovals: vi.fn(),
      ensureCreds: vi.fn(),
      ensureFunded: vi.fn(),
    }),
  },
}));

const HAPPY_STATUS = {
  funderDeployed: true,
  approvalsReady: true,
  credsReady: true,
  fundedCollateral: 100,
  funderAddress: "0xFunder000000000000000000000000000000000F",
};

const READY_PK = "0x" + "a".repeat(64);

let originalKey: string | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mockGetCapabilities.mockResolvedValue({ supportsTif: true });
  mockOnboardStatus.mockResolvedValue(HAPPY_STATUS);
  originalKey = process.env["WALLET_PRIVATE_KEY"];
  delete process.env["WALLET_PRIVATE_KEY"];
});

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env["WALLET_PRIVATE_KEY"];
  } else {
    process.env["WALLET_PRIVATE_KEY"] = originalKey;
  }
});

describe("assertReadyForLive — TIF gate", () => {
  it("throws with the strategy name + TIF when the sidecar does not advertise it", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).rejects.toThrow(/TRADE-02 --live: pmxt sidecar.*GTC/);
  });

  it("appends `tifReason` to the error when supplied", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({
        strategyName: "ARB-01",
        requiredTif: "FOK",
        tifReason: "See docs/reviews/261-open-questions.md (Q-5).",
      }),
    ).rejects.toThrow(/261-open-questions\.md/);
  });
});

describe("assertReadyForLive — onboarding gate", () => {
  it("skips the onboarding gate when no WALLET_PRIVATE_KEY is set", async () => {
    delete process.env["WALLET_PRIVATE_KEY"];
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).resolves.toBeUndefined();
    expect(mockOnboardStatus).not.toHaveBeenCalled();
  });

  it("resolves when every onboarding flag is ready", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).resolves.toBeUndefined();
    expect(mockOnboardStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects with `canon-cli onboard --execute` when the funder Safe is not deployed", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_STATUS,
      funderDeployed: false,
    });
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).rejects.toThrow(/funder Safe is not deployed.*canon-cli onboard --execute/s);
  });

  it("rejects with `--fund` remediation when the funder is empty", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_STATUS,
      fundedCollateral: 0,
    });
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).rejects.toThrow(/holds no collateral.*--execute --fund/s);
  });

  it("collects multiple missing flags into a single error", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_STATUS,
      approvalsReady: false,
      credsReady: false,
    });
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({ strategyName: "TRADE-02", requiredTif: "GTC" }),
    ).rejects.toThrow(
      /CLOB spender approvals.*CLOB API credentials/s,
    );
  });
});

describe("assertReadyForLive — auth smoke", () => {
  it("calls authSmoke last and writes its summary to stdout on success", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    const writes: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;

    const authSmoke = vi.fn(async () => ({ summary: "auth OK, USDC=12.34" }));
    try {
      const { assertReadyForLive } = await import("../live-preflight.js");
      await assertReadyForLive({
        strategyName: "TRADE-02",
        requiredTif: "GTC",
        authSmoke,
      });
    } finally {
      process.stdout.write = realWrite;
    }

    expect(authSmoke).toHaveBeenCalledTimes(1);
    expect(writes.join("")).toMatch(/TRADE-02 --live: auth OK, USDC=12\.34/);
  });

  it("wraps authSmoke failures with the strategy prefix and a remediation hint", async () => {
    process.env["WALLET_PRIVATE_KEY"] = READY_PK;
    const { assertReadyForLive } = await import("../live-preflight.js");

    await expect(
      assertReadyForLive({
        strategyName: "TRADE-02",
        requiredTif: "GTC",
        authSmoke: async () => {
          throw new Error("CLOB returned 401");
        },
      }),
    ).rejects.toThrow(
      /TRADE-02 --live: auth smoke failed: CLOB returned 401.*WALLET_PRIVATE_KEY/s,
    );
  });
});
