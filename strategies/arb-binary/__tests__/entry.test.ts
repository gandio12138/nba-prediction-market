/**
 * Tests for `canon/templates/strategies/arb-binary/entry.ts`.
 *
 * Pins the contract for the bootstrap module after the live-execution
 * refactor (item 6 of the 20260429-arb01-live-executor plan):
 *
 *   - `parseEntryFlags(argv)` returns `{ dryRun }` based on `--live` /
 *     `--dry-run`. Default (no flag) is dry-run. `--live` flips to live.
 *   - `createEntryRisk()` returns the same `ArbBinaryRisk` instance the
 *     bootstrap uses, wired with `maxConsecutiveLosses=3`. Three losses
 *     must trip the circuit breaker and reject the next signal.
 *   - `createEntryDeps({ dryRun })` returns `{ executor, positions }`
 *     wired to the live adapters from `canon/templates/live-executor.ts`
 *     and `canon/templates/live-positions.ts` — never the in-file stubs
 *     (those are removed by item 6, completion criterion: `grep -c
 *     "stubExecutor\\|stubPositions" entry.ts` returns 0).
 *
 * The Polymarket client is mocked at the module boundary so importing
 * entry.ts never touches the network and the bootstrap's top-level
 * runner.start() (if any) is harmless.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TradeSignal } from "../../../types/TradeSignal.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

const mockCreateOrder = vi.fn(async () => ({
  id: "ord-test",
  status: "submitted",
}));
const mockCancelOrder = vi.fn(async () => ({ success: true }));
const mockSearchMarkets = vi.fn(async () => []);
const mockFetchOrderBook = vi.fn(async (tokenId: string) => ({
  tokenId,
  asks: [],
  bids: [],
}));
const mockFetchBalance = vi.fn(async () => []);
const mockFetchPositions = vi.fn(async () => []);
const mockFetchOpenOrders = vi.fn(async () => []);
const mockGetCapabilities = vi.fn(async () => ({ supportsTif: true }));

vi.mock("../../../client-polymarket.js", () => ({
  createOrder: mockCreateOrder,
  cancelOrder: mockCancelOrder,
  searchMarkets: mockSearchMarkets,
  fetchOrderBook: mockFetchOrderBook,
  fetchBalance: mockFetchBalance,
  fetchPositions: mockFetchPositions,
  fetchOpenOrders: mockFetchOpenOrders,
  getCapabilities: mockGetCapabilities,
}));

// `assertReadyForLive` (used inside entry.assertLiveCapabilities) builds a
// `polymarketOnboard` adapter when `WALLET_PRIVATE_KEY` is set. Mock it so
// the suite stays hermetic — the tests in this file are about the strategy
// gate, not the live SDK.
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
  getAllowance: ((() => Promise<bigint>) & ReturnType<typeof vi.fn>);
  approve: ((amount: bigint) => Promise<{ txHash: string }>) &
    ReturnType<typeof vi.fn>;
}

interface EntryModule {
  parseEntryFlags: (argv: readonly string[]) => { dryRun: boolean };
  createEntryRisk: () => {
    preTradeCheck: (
      s: TradeSignal,
      p: Portfolio,
    ) => {
      approved: boolean;
      rejection_reason?: string;
      modified_size?: number;
    };
    recordOutcome: (won: boolean) => void;
  };
  createEntryOnOutcome: (
    risk: { recordOutcome: (won: boolean) => void },
  ) => (outcome: {
    signal: TradeSignal;
    status: "submitted" | "rejected" | "error";
    orderId?: string;
    error?: string;
  }) => void;
  createEntryDeps: (
    flags: { dryRun: boolean },
    options?: {
      allowance?: {
        getAllowance: () => Promise<bigint>;
        approve: (amount: bigint) => Promise<{ txHash: string }>;
      };
    },
  ) => {
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

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeSignal(overrides?: Partial<TradeSignal>): TradeSignal {
  return {
    automation_id: "arb-binary",
    timestamp: new Date("2026-04-29T12:00:00Z"),
    market: {
      platform: "polymarket",
      market_id: "cond-001",
      question: "Will the Lakers win?",
    },
    direction: "buy_yes",
    size: 200,
    confidence: 0.95,
    urgency: "immediate",
    metadata: {
      grossEdge: 0.2,
      totalFees: 0.036,
      netEdge: 0.164,
      netReturn: 0.205,
    },
    ...overrides,
  };
}

function makePortfolio(overrides?: Partial<Portfolio>): Portfolio {
  return {
    total_value: 10_000,
    positions: [],
    daily_pnl: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseEntryFlags — --live / --dry-run / default
// ---------------------------------------------------------------------------

describe("parseEntryFlags", () => {
  it("defaults to dry-run when no flag is provided", () => {
    const flags = entry.parseEntryFlags(["node", "entry.js"]);
    expect(flags.dryRun).toBe(true);
  });

  it("returns dryRun=false when --live is set", () => {
    const flags = entry.parseEntryFlags(["node", "entry.js", "--live"]);
    expect(flags.dryRun).toBe(false);
  });

  it("returns dryRun=true when --dry-run is explicitly set", () => {
    const flags = entry.parseEntryFlags(["node", "entry.js", "--dry-run"]);
    expect(flags.dryRun).toBe(true);
  });

  it("ignores unrelated argv entries", () => {
    const flags = entry.parseEntryFlags([
      "node",
      "entry.js",
      "--some-other-flag",
      "value",
    ]);
    expect(flags.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createEntryRisk — circuit breaker after 3 consecutive losses
// ---------------------------------------------------------------------------

describe("createEntryRisk", () => {
  it("approves a normal signal before any losses are recorded", () => {
    const risk = entry.createEntryRisk();
    const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
    expect(decision.approved).toBe(true);
  });

  it("trips the circuit breaker after 3 consecutive losses", () => {
    const risk = entry.createEntryRisk();

    risk.recordOutcome(false);
    risk.recordOutcome(false);
    risk.recordOutcome(false);

    const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
    expect(decision.approved).toBe(false);
    expect(decision.rejection_reason).toBeDefined();
    expect(decision.rejection_reason).toMatch(/circuit.?breaker/i);
  });

  it("does NOT trip the circuit breaker after only 2 consecutive losses", () => {
    const risk = entry.createEntryRisk();

    risk.recordOutcome(false);
    risk.recordOutcome(false);

    const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
    expect(decision.approved).toBe(true);
  });

  it("resets the consecutive-loss counter on a win", () => {
    const risk = entry.createEntryRisk();

    risk.recordOutcome(false);
    risk.recordOutcome(false);
    risk.recordOutcome(true); // win — reset
    risk.recordOutcome(false);
    risk.recordOutcome(false);

    const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
    expect(decision.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createEntryDeps — wires live executor / positions, no stubs
// ---------------------------------------------------------------------------

describe("createEntryOnOutcome", () => {
  it("records a loss when the outcome is `rejected`", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({ signal: makeSignal(), status: "rejected" });

    expect(recordSpy).toHaveBeenCalledWith(false);
  });

  it("records a loss when the outcome is `error`", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({ signal: makeSignal(), status: "error", error: "boom" });

    expect(recordSpy).toHaveBeenCalledWith(false);
  });

  it("does not record a win on a single-leg `submitted` (pair incomplete)", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({
      signal: makeSignal(),
      status: "submitted",
      orderId: "ord-test",
    });

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("records a win when both YES and NO legs of the same market submit (Q-2)", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({
      signal: makeSignal({ direction: "buy_yes" }),
      status: "submitted",
      orderId: "ord-yes",
    });
    expect(recordSpy).not.toHaveBeenCalled();

    onOutcome({
      signal: makeSignal({ direction: "buy_no" }),
      status: "submitted",
      orderId: "ord-no",
    });

    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(true);
  });

  it("does not double-count a win when the same leg submits twice", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({
      signal: makeSignal({ direction: "buy_yes" }),
      status: "submitted",
      orderId: "ord-yes-1",
    });
    onOutcome({
      signal: makeSignal({ direction: "buy_yes" }),
      status: "submitted",
      orderId: "ord-yes-2",
    });

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("isolates leg tracking per market_id", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({
      signal: makeSignal({
        direction: "buy_yes",
        market: {
          platform: "polymarket",
          market_id: "cond-A",
          question: "A?",
        },
      }),
      status: "submitted",
    });
    onOutcome({
      signal: makeSignal({
        direction: "buy_no",
        market: {
          platform: "polymarket",
          market_id: "cond-B",
          question: "B?",
        },
      }),
      status: "submitted",
    });

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it("clears pending leg state when the pair's other leg fails", () => {
    const risk = entry.createEntryRisk();
    const recordSpy = vi.spyOn(risk, "recordOutcome");
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({
      signal: makeSignal({ direction: "buy_yes" }),
      status: "submitted",
      orderId: "ord-yes",
    });
    onOutcome({
      signal: makeSignal({ direction: "buy_no" }),
      status: "rejected",
    });
    // The previous YES-only state must NOT combine with a future NO
    // to retroactively mark a win.
    onOutcome({
      signal: makeSignal({ direction: "buy_no" }),
      status: "submitted",
      orderId: "ord-no",
    });

    // Only the rejected NO records a loss; the lingering YES from
    // before the rejection is cleared, so the late NO submit tracks
    // alone — no win recorded.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(false);
  });

  it("trips the circuit breaker after 3 rejected outcomes", () => {
    const risk = entry.createEntryRisk();
    const onOutcome = entry.createEntryOnOutcome(risk);

    onOutcome({ signal: makeSignal(), status: "rejected" });
    onOutcome({ signal: makeSignal(), status: "rejected" });
    onOutcome({ signal: makeSignal(), status: "rejected" });

    const decision = risk.preTradeCheck(makeSignal(), makePortfolio());
    expect(decision.approved).toBe(false);
    expect(decision.rejection_reason).toMatch(/circuit.?breaker/i);
  });
});

describe("createEntryDeps", () => {
  it("returns an executor and a positions adapter regardless of dryRun", () => {
    const live = entry.createEntryDeps({ dryRun: false });
    expect(typeof live.executor.submit).toBe("function");
    expect(typeof live.positions.reconcile).toBe("function");
    expect(typeof live.positions.getPortfolio).toBe("function");

    const dry = entry.createEntryDeps({ dryRun: true });
    expect(typeof dry.executor.submit).toBe("function");
    expect(typeof dry.positions.reconcile).toBe("function");
  });

  it("wires the live polymarket client into executor.submit (no stub)", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    const result = await deps.executor.submit(makeSignal());

    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("ord-test");
    expect(result.status).toBe("submitted");
  });

  it("wires the live polymarket client into positions.reconcile (no stub)", async () => {
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.positions.reconcile();

    expect(mockFetchBalance).toHaveBeenCalledTimes(1);
    expect(mockFetchPositions).toHaveBeenCalledTimes(1);
    expect(mockFetchOpenOrders).toHaveBeenCalledTimes(1);
  });

  it("threads an injected allowance client into the live executor (Q-3)", async () => {
    const allowance = makeFakeAllowance(0n);
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(makeSignal());

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).toHaveBeenCalledTimes(1);
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
  });

  it("does not approve when the cached allowance already meets the threshold", async () => {
    // 100k USDC threshold (6 decimals) — supply more than that.
    const allowance = makeFakeAllowance(200_000_000_000n);
    const deps = entry.createEntryDeps({ dryRun: false }, { allowance });

    await deps.executor.submit(makeSignal());
    await deps.executor.submit(makeSignal());

    expect(allowance.getAllowance).toHaveBeenCalledTimes(1);
    expect(allowance.approve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration trace — scan → signal → submit produces CLOB-shaped order
// ---------------------------------------------------------------------------

describe("integration trace (scan → signal → submit)", () => {
  it("forwards a real CLOB token id (77-digit decimal) to createOrder", async () => {
    const { detectSignals } = (await import(
      "../signal.js"
    )) as typeof import("../signal.js");
    const { signalToOrderParams } = (await import(
      "../../../order-executor.js"
    )) as typeof import("../../../order-executor.js");

    const yesTokenId =
      "12345678901234567890123456789012345678901234567890123456789012345";
    const noTokenId =
      "98765432109876543210987654321098765432109876543210987654321098765";

    const signals = detectSignals(
      [
        {
          conditionId: "0xcondition",
          question: "Will it rain?",
          category: "NBA",
          yesAsk: 0.4,
          noAsk: 0.4,
          yesTokenId,
          noTokenId,
          estimatedSlippage: 0.001,
        },
      ],
      {
        category: "NBA",
        feeRate: 0.02,
        gasCost: 0.02,
        hurdleRate: 0.015,
        slippageAbort: 0.003,
        bankroll: 10_000,
        kellyFraction: 0.25,
        maxExposure: 0.08,
        signalTtlMs: 5_000,
      },
    );

    expect(signals.length).toBeGreaterThan(0);
    const yesSignal = signals.find((s) => s.direction === "buy_yes")!;

    // Direct chain: signal → signalToOrderParams → CLOB-shaped params.
    const params = signalToOrderParams(
      yesSignal,
      { yes: yesTokenId, no: noTokenId },
      yesSignal.metadata["yesAsk"] as number,
      "FOK",
    );

    expect(params.tokenId).toMatch(/^\d{60,}$/);
    expect(params.price).toBeGreaterThanOrEqual(0);
    expect(params.price).toBeLessThanOrEqual(1);
    expect(params.size).toBeGreaterThan(0);
    expect(params.orderType).toBe("limit");
    expect(params.timeInForce).toBe("FOK");

    // End-to-end via the live executor still produces the same shape.
    const deps = entry.createEntryDeps({ dryRun: false });
    await deps.executor.submit(yesSignal);

    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: expect.stringMatching(/^\d{60,}$/),
        timeInForce: "FOK",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildLiveAllowanceClient — WalletStore injection (Q-3 architecture)
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
    getPrivateKey: vi.fn(
      () => opts.privateKey ?? "0x" + "a".repeat(64),
    ),
    getAddress: vi.fn(async () => opts.address ?? "0xowner"),
    ensure: vi.fn(),
  };
}

interface BuildLiveAllowanceClientFn {
  (wallet: FakeWalletStore): Promise<unknown>;
}

describe("buildLiveAllowanceClient (WalletStore injection)", () => {
  it("returns undefined when the wallet store has no wallet", async () => {
    const wallet = makeFakeWallet({ hasWallet: false });
    const build = (entry as unknown as { buildLiveAllowanceClient: BuildLiveAllowanceClientFn }).buildLiveAllowanceClient;
    const client = await build(wallet);
    expect(client).toBeUndefined();
    expect(wallet.hasWallet).toHaveBeenCalled();
    expect(wallet.getAddress).not.toHaveBeenCalled();
  });

  it("derives owner address from wallet.getAddress() (no env vars consulted)", async () => {
    const prevOwner = process.env["WALLET_PROXY_ADDRESS"];
    delete process.env["WALLET_PROXY_ADDRESS"];
    const wallet = makeFakeWallet({ address: "0xfromwallet" });
    const build = (entry as unknown as { buildLiveAllowanceClient: BuildLiveAllowanceClientFn }).buildLiveAllowanceClient;
    const client = await build(wallet);
    expect(client).toBeDefined();
    expect(wallet.getAddress).toHaveBeenCalledTimes(1);
    if (prevOwner !== undefined) {
      process.env["WALLET_PROXY_ADDRESS"] = prevOwner;
    }
  });
});

// ---------------------------------------------------------------------------
// assertLiveCapabilities — start-up safety gate (Q-5)
// ---------------------------------------------------------------------------

describe("assertLiveCapabilities", () => {
  it("resolves when the sidecar advertises FOK support", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: true });
    await expect(entry.assertLiveCapabilities()).resolves.toBeUndefined();
    expect(mockGetCapabilities).toHaveBeenCalledTimes(1);
  });

  it("rejects when the sidecar does not advertise FOK support", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(/FOK/);
  });

  it("error message points at the open-questions doc (Q-5)", async () => {
    mockGetCapabilities.mockResolvedValueOnce({ supportsTif: false });
    await expect(entry.assertLiveCapabilities()).rejects.toThrow(
      /261-open-questions\.md/,
    );
  });
});
