/**
 * Tests for `canon/templates/strategies/mint-01/entry.ts`.
 *
 * Covers the four clauses from the plan item:
 *   1. flag parsing — `--live` flips dryRun, default is dry-run.
 *   2. capability gate — `assertLiveCapabilities` consults the sidecar
 *      and refuses to run when `supportsTif` is false.
 *   3. allowance injection — `createEntryDeps({ allowance })` threads a
 *      fake `AllowanceClient` into the live executor; the executor
 *      consults `getAllowance` and tops up via `approve` before the
 *      first `createOrder`.
 *   4. integration trace — `detectMint01Candidate → planLegs →
 *      signalToOrderParams` produces CLOB-shaped tokenIds on BOTH the
 *      sell_yes and sell_no legs, and the same shape reaches
 *      `createOrder` end-to-end via the live executor.
 *
 * The Polymarket client is mocked at the module boundary so importing
 * entry.ts never touches the network.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { MarketCandidate } from "../cycle.js";

const mockCreateOrder = vi.fn(async (params: { tokenId: string }) => ({
  id: `ord-${params.tokenId.slice(0, 6)}`,
  marketId: "cond-001",
  outcomeId: params.tokenId,
  side: "sell" as const,
  type: "limit" as const,
  amount: 0,
  price: 0,
  status: "submitted",
  filled: 0,
  remaining: 0,
}));
const mockCancelOrder = vi.fn(async () => ({ id: "ord-x", status: "cancelled" }));
const mockGetCapabilities = vi.fn(async () => ({ supportsTif: true }));

vi.mock("../../../client-polymarket.js", () => ({
  createOrder: mockCreateOrder,
  cancelOrder: mockCancelOrder,
  getCapabilities: mockGetCapabilities,
}));

interface FakeAllowanceClient {
  getAllowance: (() => Promise<bigint>) & ReturnType<typeof vi.fn>;
  approve: ((amount: bigint) => Promise<{ txHash: string }>) &
    ReturnType<typeof vi.fn>;
}

function makeFakeAllowance(initial = 0n): FakeAllowanceClient {
  return {
    getAllowance: vi.fn(async () => initial),
    approve: vi.fn(async () => ({ txHash: "0xabc" })),
  };
}

interface EntryModule {
  parseEntryFlags: (argv: readonly string[]) => { dryRun: boolean };
  assertLiveCapabilities: () => Promise<void>;
  detectMint01Candidate: typeof import("../entry.js").detectMint01Candidate;
  resolveMint01Order: typeof import("../entry.js").resolveMint01Order;
  createEntryDeps: typeof import("../entry.js").createEntryDeps;
  buildLiveAllowanceClient: typeof import("../entry.js").buildLiveAllowanceClient;
}

let entry: EntryModule;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mockGetCapabilities.mockImplementation(async () => ({ supportsTif: true }));
  entry = (await import("../entry.js")) as unknown as EntryModule;
});

const YES_TOKEN_ID =
  "12345678901234567890123456789012345678901234567890123456789012345";
const NO_TOKEN_ID =
  "98765432109876543210987654321098765432109876543210987654321098765";

function makeCandidate(overrides?: Partial<MarketCandidate>): MarketCandidate {
  return {
    conditionId: "0xcondition",
    question: "Will the Lakers win?",
    midpoint: 0.5,
    timeToCloseMs: 7 * 24 * 60 * 60 * 1000,
    volume24h: 50_000,
    openInterest: 20_000,
    yesTokenId: YES_TOKEN_ID,
    noTokenId: NO_TOKEN_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseEntryFlags
// ---------------------------------------------------------------------------

describe("parseEntryFlags", () => {
  it("defaults to dry-run when no flag is provided", () => {
    expect(entry.parseEntryFlags(["node", "entry.js"]).dryRun).toBe(true);
  });

  it("returns dryRun=false when --live is set", () => {
    expect(
      entry.parseEntryFlags(["node", "entry.js", "--live"]).dryRun,
    ).toBe(false);
  });

  it("returns dryRun=true when --dry-run is explicitly set", () => {
    expect(
      entry.parseEntryFlags(["node", "entry.js", "--dry-run"]).dryRun,
    ).toBe(true);
  });

  it("ignores unrelated argv entries", () => {
    expect(
      entry.parseEntryFlags(["node", "entry.js", "--other", "v"]).dryRun,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertLiveCapabilities
// ---------------------------------------------------------------------------

describe("assertLiveCapabilities", () => {
  it("resolves when the sidecar advertises tif support", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: true });
    await expect(entry.assertLiveCapabilities()).resolves.toBeUndefined();
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
  });

  it("rejects when the sidecar does not advertise tif support", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /time-in-force/,
    );
  });
});

// ---------------------------------------------------------------------------
// detectMint01Candidate — emits a CLOB-shaped two-leg signal pair
// ---------------------------------------------------------------------------

describe("detectMint01Candidate", () => {
  it("returns null when no candidate passes the filter gate", () => {
    const result = entry.detectMint01Candidate([
      makeCandidate({ volume24h: 0, openInterest: 0 }),
    ]);
    expect(result).toBeNull();
  });

  it("emits sell_yes + sell_no signals at midpoint + premium on each leg", () => {
    const result = entry.detectMint01Candidate([makeCandidate()]);
    expect(result).not.toBeNull();
    const { signals, legs } = result!;
    expect(signals).toHaveLength(2);
    const [yesSig, noSig] = signals;
    expect(yesSig.direction).toBe("sell_yes");
    expect(noSig.direction).toBe("sell_no");
    expect(yesSig.metadata["yesTokenId"]).toBe(YES_TOKEN_ID);
    expect(yesSig.metadata["noTokenId"]).toBe(NO_TOKEN_ID);
    expect(noSig.metadata["yesTokenId"]).toBe(YES_TOKEN_ID);
    expect(noSig.metadata["noTokenId"]).toBe(NO_TOKEN_ID);
    expect(legs.yesPrice).toBeCloseTo(0.5075, 6);
    expect(legs.noPrice).toBeCloseTo(0.5075, 6);
    expect(yesSig.size).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// createEntryDeps — wires LiveExecutor + allowance injection
// ---------------------------------------------------------------------------

describe("createEntryDeps", () => {
  it("returns a live executor with submit/cancel functions", () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    expect(typeof deps.executor.submit).toBe("function");
    expect(typeof deps.executor.cancel).toBe("function");
  });

  it("threads an injected allowance client into the live executor", async () => {
    const allowance = makeFakeAllowance(0n);
    const result = entry.detectMint01Candidate([makeCandidate()])!;
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(result.signals[0]);

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).toHaveBeenCalledTimes(1);
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
  });

  it("does not approve when the cached allowance already meets the threshold", async () => {
    const allowance = makeFakeAllowance(200_000_000_000n);
    const result = entry.detectMint01Candidate([makeCandidate()])!;
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(result.signals[0]);
    await deps.executor.submit(result.signals[1]);

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).not.toHaveBeenCalled();
    expect(mockCreateOrder).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// resolveMint01Order — picks the correct tokenId/price per leg
// ---------------------------------------------------------------------------

describe("resolveMint01Order", () => {
  it("returns the YES tokenId and yesPrice for the sell_yes leg", () => {
    const { signals } = entry.detectMint01Candidate([makeCandidate()])!;
    const resolved = entry.resolveMint01Order(signals[0]);
    expect(resolved.tokenIds.yes).toBe(YES_TOKEN_ID);
    expect(resolved.tokenIds.no).toBe(NO_TOKEN_ID);
    expect(resolved.price).toBeCloseTo(0.5075, 6);
    expect(resolved.timeInForce).toBe("GTC");
  });

  it("returns the NO leg's noPrice for the sell_no leg", () => {
    const { signals } = entry.detectMint01Candidate([
      makeCandidate({ midpoint: 0.4 }),
    ])!;
    const resolved = entry.resolveMint01Order(signals[1]);
    expect(resolved.price).toBeCloseTo(0.6075, 6);
  });

  it("throws when token ids are missing from metadata", () => {
    const stub: TradeSignal = {
      automation_id: "mint-01",
      timestamp: new Date(),
      market: { platform: "polymarket", market_id: "x", question: "?" },
      direction: "sell_yes",
      size: 1,
      confidence: 1,
      urgency: "normal",
      metadata: { yesPrice: 0.5, noPrice: 0.5 },
    };
    expect(() => entry.resolveMint01Order(stub)).toThrow(/yesTokenId/);
  });
});

// ---------------------------------------------------------------------------
// Integration trace — both legs reach createOrder with CLOB-shaped tokenIds
// ---------------------------------------------------------------------------

describe("integration trace (selectMarket → planLegs → signalToOrderParams)", () => {
  it("forwards 77-digit decimal token ids for BOTH legs end-to-end", async () => {
    const { signalToOrderParams } = (await import(
      "../../../order-executor.js"
    )) as typeof import("../../../order-executor.js");

    const detected = entry.detectMint01Candidate([makeCandidate()]);
    expect(detected).not.toBeNull();
    const [yesSig, noSig] = detected!.signals;

    // Direct chain: signal → resolveMint01Order → signalToOrderParams.
    const yesResolved = entry.resolveMint01Order(yesSig);
    const yesParams = signalToOrderParams(
      yesSig,
      yesResolved.tokenIds,
      yesResolved.price,
      yesResolved.timeInForce,
    );
    const noResolved = entry.resolveMint01Order(noSig);
    const noParams = signalToOrderParams(
      noSig,
      noResolved.tokenIds,
      noResolved.price,
      noResolved.timeInForce,
    );

    expect(yesParams.tokenId).toBe(YES_TOKEN_ID);
    expect(yesParams.tokenId).toMatch(/^\d{60,}$/);
    expect(yesParams.side).toBe("sell");
    expect(yesParams.orderType).toBe("limit");
    expect(yesParams.timeInForce).toBe("GTC");

    expect(noParams.tokenId).toBe(NO_TOKEN_ID);
    expect(noParams.tokenId).toMatch(/^\d{60,}$/);
    expect(noParams.side).toBe("sell");

    // End-to-end via the live executor still produces the same shape on
    // both legs.
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.executor.submit(yesSig);
    await deps.executor.submit(noSig);

    expect(mockCreateOrder).toHaveBeenCalledTimes(2);
    expect(mockCreateOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tokenId: YES_TOKEN_ID,
        side: "sell",
        timeInForce: "GTC",
      }),
    );
    expect(mockCreateOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tokenId: NO_TOKEN_ID,
        side: "sell",
        timeInForce: "GTC",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildLiveAllowanceClient — WalletStore injection
// ---------------------------------------------------------------------------

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

describe("buildLiveAllowanceClient (WalletStore injection)", () => {
  it("returns undefined when the wallet store has no wallet", async () => {
    const wallet = makeFakeWallet({ hasWallet: false });
    const client = await entry.buildLiveAllowanceClient(
      wallet as unknown as Parameters<typeof entry.buildLiveAllowanceClient>[0],
    );
    expect(client).toBeUndefined();
    expect(wallet.hasWallet).toHaveBeenCalled();
    expect(wallet.getAddress).not.toHaveBeenCalled();
  });

  it("derives owner address from wallet.getAddress()", async () => {
    const wallet = makeFakeWallet({ address: "0xfromwallet" });
    const client = await entry.buildLiveAllowanceClient(
      wallet as unknown as Parameters<typeof entry.buildLiveAllowanceClient>[0],
    );
    expect(client).toBeDefined();
    expect(wallet.getAddress).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when getAddress throws", async () => {
    const wallet = makeFakeWallet();
    wallet.getAddress.mockImplementationOnce(async () => {
      throw new Error("WalletNotFoundError");
    });
    const client = await entry.buildLiveAllowanceClient(
      wallet as unknown as Parameters<typeof entry.buildLiveAllowanceClient>[0],
    );
    expect(client).toBeUndefined();
  });
});
