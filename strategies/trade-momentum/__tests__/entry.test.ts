/**
 * Tests for `canon/templates/strategies/trade-momentum/entry.ts`.
 *
 * Pins the live-execution wiring contract:
 *   - `parseEntryFlags(argv)` defaults to dry-run; `--live` opts in.
 *   - `createEntryDeps()` returns live executor + live positions + live
 *     scan adapter — never the previous in-file stubs.
 *   - `executor.submit` calls into the polymarket client with GTC TIF.
 *   - Allowance client is consulted before submission and `approve` only
 *     runs when the cached allowance is below the threshold.
 *   - `assertLiveCapabilities` rejects when the sidecar lacks TIF.
 *   - `buildLiveAllowanceClient` returns undefined for an empty wallet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

const mockCreateOrder = vi.fn(async () => ({
  id: "ord-test",
  status: "submitted",
}));
const mockCancelOrder = vi.fn(async () => ({ success: true }));
const mockFetchBinaryMarketSnapshots = vi.fn(async () => []);
const mockFetchBalance = vi.fn(async () => []);
const mockFetchPositions = vi.fn(async () => []);
const mockFetchOpenOrders = vi.fn(async () => []);
const mockGetCapabilities = vi.fn(async () => ({ supportsTif: true }));

vi.mock("../../../client-polymarket.js", () => ({
  createOrder: mockCreateOrder,
  cancelOrder: mockCancelOrder,
  fetchBinaryMarketSnapshots: mockFetchBinaryMarketSnapshots,
  fetchBalance: mockFetchBalance,
  fetchPositions: mockFetchPositions,
  fetchOpenOrders: mockFetchOpenOrders,
  getCapabilities: mockGetCapabilities,
}));

interface OnboardStatusShape {
  funderDeployed: boolean;
  approvalsReady: boolean;
  credsReady: boolean;
  fundedCollateral: number;
  funderAddress: string;
}

const HAPPY_ONBOARD_STATUS: OnboardStatusShape = {
  funderDeployed: true,
  approvalsReady: true,
  credsReady: true,
  fundedCollateral: 1234.56,
  funderAddress: "0xFunder000000000000000000000000000000000F",
};

const mockOnboardStatus = vi.fn(async (): Promise<OnboardStatusShape> => HAPPY_ONBOARD_STATUS);
const mockOnboardEnsureFunder = vi.fn(async () => ({ deployed: true }));
const mockOnboardEnsureApprovals = vi.fn(async () => ({ approved: true }));
const mockOnboardEnsureCreds = vi.fn(async () => ({
  key: "k",
  secret: "s",
  passphrase: "p",
}));
const mockOnboardEnsureFunded = vi.fn(async () => ({
  funded: true,
  amount: 0n,
  expectedOut: 0n,
}));
const mockOnboardBuild = vi.fn(() => ({
  status: mockOnboardStatus,
  ensureFunder: mockOnboardEnsureFunder,
  ensureApprovals: mockOnboardEnsureApprovals,
  ensureCreds: mockOnboardEnsureCreds,
  ensureFunded: mockOnboardEnsureFunded,
}));

vi.mock("../../../polymarket-onboard.js", () => ({
  polymarketOnboard: {
    venue: "polymarket",
    chainId: 137,
    build: mockOnboardBuild,
  },
}));

interface FakeAllowanceClient {
  getAllowance: (() => Promise<bigint>) & ReturnType<typeof vi.fn>;
  approve: ((amount: bigint) => Promise<{ txHash: string }>) &
    ReturnType<typeof vi.fn>;
}

interface EntryModule {
  parseEntryFlags: (argv: readonly string[]) => { dryRun: boolean };
  createEntryDeps: (
    flags: { dryRun: boolean },
    options?: { allowance?: FakeAllowanceClient; query?: string },
  ) => {
    scan: { fetchSnapshots: () => Promise<unknown[]> };
    executor: {
      submit: (s: TradeSignal) => Promise<{ id: string; status: string }>;
    };
    positions: {
      reconcile: () => Promise<Portfolio>;
      getPortfolio: () => Portfolio;
    };
  };
  assertLiveCapabilities: () => Promise<void>;
  buildLiveAllowanceClient: (wallet: unknown) => Promise<unknown>;
}

let entry: EntryModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env["WALLET_PRIVATE_KEY"] = "0x" + "a".repeat(64);
  mockGetCapabilities.mockImplementation(async () => ({ supportsTif: true }));
  mockOnboardStatus.mockImplementation(async () => HAPPY_ONBOARD_STATUS);
  mockOnboardBuild.mockImplementation(() => ({
    status: mockOnboardStatus,
    ensureFunder: mockOnboardEnsureFunder,
    ensureApprovals: mockOnboardEnsureApprovals,
    ensureCreds: mockOnboardEnsureCreds,
    ensureFunded: mockOnboardEnsureFunded,
  }));
  entry = (await import("../entry.js")) as unknown as EntryModule;
});

function makeFakeAllowance(initial = 0n): FakeAllowanceClient {
  return {
    getAllowance: vi.fn(async () => initial),
    approve: vi.fn(async () => ({ txHash: "0xabc" })),
  };
}

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    automation_id: "trade-momentum",
    timestamp: new Date("2026-04-30T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will price rise?",
    },
    direction: "buy_yes",
    size: 100,
    confidence: 0.6,
    urgency: "normal",
    metadata: {
      yesTokenId:
        "12345678901234567890123456789012345678901234567890123456789012345",
      noTokenId:
        "98765432109876543210987654321098765432109876543210987654321098765",
      entryPrice: 0.18,
    },
    ...overrides,
  };
}

describe("parseEntryFlags", () => {
  it("defaults to dry-run", () => {
    expect(entry.parseEntryFlags(["node", "entry.js"]).dryRun).toBe(true);
  });

  it("returns dryRun=false when --live is set", () => {
    expect(entry.parseEntryFlags(["node", "entry.js", "--live"]).dryRun).toBe(
      false,
    );
  });
});

describe("createEntryDeps", () => {
  it("returns live scan + executor + positions adapters", () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    expect(typeof deps.scan.fetchSnapshots).toBe("function");
    expect(typeof deps.executor.submit).toBe("function");
    expect(typeof deps.positions.reconcile).toBe("function");
  });

  it("scan.fetchSnapshots calls the live polymarket client", async () => {
    const deps = entry.createEntryDeps(
      { dryRun: false },
      { query: "NBA" },
    );
    await deps.scan.fetchSnapshots();
    expect(mockFetchBinaryMarketSnapshots).toHaveBeenCalledWith("NBA");
  });

  it("executor.submit forwards GTC time-in-force to createOrder", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.executor.submit(makeSignal());

    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: expect.stringMatching(/^\d{60,}$/),
        timeInForce: "GTC",
        orderType: "limit",
      }),
    );
  });

  it("positions.reconcile calls the live polymarket client", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.positions.reconcile();
    expect(mockFetchBalance).toHaveBeenCalledTimes(1);
    expect(mockFetchPositions).toHaveBeenCalledTimes(1);
    expect(mockFetchOpenOrders).toHaveBeenCalledTimes(1);
  });

  it("threads an injected allowance client through the live executor", async () => {
    const allowance = makeFakeAllowance(0n);
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(makeSignal());

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).toHaveBeenCalledTimes(1);
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
  });

  it("does not approve when cached allowance already meets the threshold", async () => {
    const allowance = makeFakeAllowance(200_000_000_000n);
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(makeSignal());
    await deps.executor.submit(makeSignal());

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).not.toHaveBeenCalled();
  });
});

describe("assertLiveCapabilities", () => {
  it("resolves when the sidecar advertises TIF support and auth smoke succeeds", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: true });
    mockFetchBalance.mockResolvedValueOnce([]);
    await expect(entry.assertLiveCapabilities()).resolves.toBeUndefined();
  });

  it("rejects when the sidecar does not advertise TIF support", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(/GTC/);
  });

  it("rejects with a clear message when the auth smoke fails", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: true });
    mockFetchBalance.mockRejectedValueOnce(
      new Error("Derived credentials are incomplete"),
    );
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /auth smoke failed/,
    );
  });

  it("calls polymarketOnboard.build(pk).status() with the wallet PK", async () => {
    await entry.assertLiveCapabilities();
    expect(mockOnboardBuild).toHaveBeenCalledTimes(1);
    expect(mockOnboardBuild).toHaveBeenCalledWith(
      "0x" + "a".repeat(64),
    );
    expect(mockOnboardStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects with `canon-cli onboard --execute` when funder is not deployed", async () => {
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_ONBOARD_STATUS,
      funderDeployed: false,
      fundedCollateral: 0,
    });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /funder Safe is not deployed.*canon-cli onboard --execute/s,
    );
  });

  it("rejects with a 'send native USDC' message when the funder is empty", async () => {
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_ONBOARD_STATUS,
      fundedCollateral: 0,
    });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /holds no collateral.*send native USDC/i,
    );
  });

  it("rejects with `canon-cli onboard --execute` when approvals are missing", async () => {
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_ONBOARD_STATUS,
      approvalsReady: false,
    });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /CLOB spender approvals.*canon-cli onboard --execute/s,
    );
  });

  it("rejects with `canon-cli onboard --execute` when CLOB creds are not derivable", async () => {
    mockOnboardStatus.mockResolvedValueOnce({
      ...HAPPY_ONBOARD_STATUS,
      credsReady: false,
    });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /CLOB API credentials.*canon-cli onboard --execute/s,
    );
  });

  it("does not call onboard.status() when WALLET_PRIVATE_KEY is unset", async () => {
    delete process.env["WALLET_PRIVATE_KEY"];
    await entry.assertLiveCapabilities();
    expect(mockOnboardBuild).not.toHaveBeenCalled();
    expect(mockOnboardStatus).not.toHaveBeenCalled();
  });
});

interface FakeWalletStore {
  hasWallet: ReturnType<typeof vi.fn>;
  getPrivateKey: ReturnType<typeof vi.fn>;
  getAddress: ReturnType<typeof vi.fn>;
  ensure: ReturnType<typeof vi.fn>;
}

function makeFakeWallet(opts: {
  hasWallet?: boolean;
  address?: string;
  privateKey?: string;
} = {}): FakeWalletStore {
  return {
    hasWallet: vi.fn(() => opts.hasWallet ?? true),
    getPrivateKey: vi.fn(() => opts.privateKey ?? "0x" + "a".repeat(64)),
    getAddress: vi.fn(async () => opts.address ?? "0xowner"),
    ensure: vi.fn(),
  };
}

describe("buildLiveAllowanceClient", () => {
  it("returns undefined when the wallet store has no wallet", async () => {
    const wallet = makeFakeWallet({ hasWallet: false });
    const client = await entry.buildLiveAllowanceClient(wallet);
    expect(client).toBeUndefined();
  });

  it("derives the owner address from wallet.getAddress()", async () => {
    const wallet = makeFakeWallet({ address: "0xfromwallet" });
    const client = await entry.buildLiveAllowanceClient(wallet);
    expect(client).toBeDefined();
    expect(wallet.getAddress).toHaveBeenCalledTimes(1);
  });
});
