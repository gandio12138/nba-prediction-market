/**
 * Tests for `canon/templates/strategies/fair-value/entry.ts`.
 *
 * Pins the live-execution wiring contract.
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

const mockOnboardStatus = vi.fn(async () => ({
  funderDeployed: true,
  approvalsReady: true,
  credsReady: true,
  fundedCollateral: 100,
  funderAddress: "0xFunder000000000000000000000000000000000F",
}));

vi.mock("../../../polymarket-onboard.js", () => ({
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
    scan: { fetchSnapshots: () => Promise<unknown[]>; model: unknown };
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
  entry = (await import("../entry.js")) as unknown as EntryModule;
});

function makeFakeAllowance(initial = 0n): FakeAllowanceClient {
  return {
    getAllowance: vi.fn(async () => initial),
    approve: vi.fn(async () => ({ txHash: "0xabc" })),
  };
}

const yesTokenId =
  "12345678901234567890123456789012345678901234567890123456789012345";
const noTokenId =
  "98765432109876543210987654321098765432109876543210987654321098765";

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    automation_id: "fair-value",
    timestamp: new Date("2026-04-30T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will it rain?",
    },
    direction: "buy_yes",
    size: 100,
    confidence: 0.6,
    urgency: "normal",
    metadata: {
      yesTokenId,
      noTokenId,
      marketPrice: 0.4,
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
    expect(deps.scan.model).toBeDefined();
    expect(typeof deps.executor.submit).toBe("function");
    expect(typeof deps.positions.reconcile).toBe("function");
  });

  it("scan.fetchSnapshots calls the live polymarket client", async () => {
    const deps = entry.createEntryDeps(
      { dryRun: false },
      { query: "Sports" },
    );
    await deps.scan.fetchSnapshots();
    expect(mockFetchBinaryMarketSnapshots).toHaveBeenCalledWith("Sports");
  });

  it("buy_yes uses YES token at marketPrice with GTC", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.executor.submit(makeSignal({ direction: "buy_yes" }));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: yesTokenId,
        side: "buy",
        price: 0.4,
        timeInForce: "GTC",
        orderType: "limit",
      }),
    );
  });

  it("buy_no uses NO token at (1 - marketPrice) with GTC", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.executor.submit(makeSignal({ direction: "buy_no" }));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: noTokenId,
        side: "buy",
        price: 0.6,
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
  it("resolves when sidecar advertises TIF", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: true });
    await expect(entry.assertLiveCapabilities()).resolves.toBeUndefined();
  });

  it("rejects when sidecar lacks TIF", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(/GTC/);
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
  it("returns undefined when wallet store has no wallet", async () => {
    const wallet = makeFakeWallet({ hasWallet: false });
    expect(await entry.buildLiveAllowanceClient(wallet)).toBeUndefined();
  });

  it("derives owner address from wallet.getAddress()", async () => {
    const wallet = makeFakeWallet({ address: "0xfromwallet" });
    const client = await entry.buildLiveAllowanceClient(wallet);
    expect(client).toBeDefined();
    expect(wallet.getAddress).toHaveBeenCalledTimes(1);
  });
});
