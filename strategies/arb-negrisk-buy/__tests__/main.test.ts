import { describe, it, expect, vi } from "vitest";
import { createNegRiskBuyRunner } from "../main.js";
import type {
  NegRiskBuyRunnerConfig,
  NegRiskBuyRunnerDeps,
} from "../main.js";
import type { ExecutionLogEntry } from "../../../execution-log.js";
import type { OrderBook } from "../../../client-polymarket.js";
import type { ScanSearchResult } from "../scan.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

// ---------------------------------------------------------------------------
// Hardcoded mock API data — NBA Champion NegRisk market with clear arb edge.
// Sum of YES bids = 0.30 + 0.25 + 0.20 = 0.75 < sumThreshold (0.97);
// per-leg liquidity comfortably above 300; no thin/high-priced legs.
// ---------------------------------------------------------------------------

const MOCK_MARKETS: ScanSearchResult[] = [
  {
    conditionId: "cond-arb-neg-001",
    question: "Who wins the 2026 NBA Championship?",
    isNegRisk: true,
    legs: [
      { outcome: "Lakers", tokenId: "tok-lak" },
      { outcome: "Celtics", tokenId: "tok-cel" },
      { outcome: "Nuggets", tokenId: "tok-nug" },
    ],
  },
];

const MOCK_BOOKS: Record<string, OrderBook> = {
  "tok-lak": {
    tokenId: "tok-lak",
    asks: [{ price: 0.31, size: 1_000 }],
    bids: [{ price: 0.30, size: 1_000 }],
  },
  "tok-cel": {
    tokenId: "tok-cel",
    asks: [{ price: 0.26, size: 1_000 }],
    bids: [{ price: 0.25, size: 1_000 }],
  },
  "tok-nug": {
    tokenId: "tok-nug",
    asks: [{ price: 0.21, size: 1_000 }],
    bids: [{ price: 0.20, size: 1_000 }],
  },
};

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<NegRiskBuyRunnerConfig>,
): NegRiskBuyRunnerConfig {
  return {
    strategy: {
      category: "NBA Champion",
      feeRate: 0.02,
      gasPerLeg: 0.05,
      hurdleRate: 0.03,
      bankroll: 10_000,
      kellyFraction: 0.15,
      maxExposure: 0.05,
      signalTtlMs: 15_000,
      minLegLiquidity: 300,
      maxLegPriceWithLowLiq: 0.30,
      lowLiqThreshold: 100,
      sumThreshold: 0.97,
    },
    runner: {
      pollIntervalMs: 10,
      dryRun: true,
      baseDir: "/tmp/arb-negrisk-test",
      statePath: "/tmp/arb-negrisk-test/state.json",
    },
    maxConsecutiveLosses: 3,
    ...overrides,
  };
}

function makeEmptyPortfolio(): Portfolio {
  return {
    total_value: 10_000,
    positions: [],
    daily_pnl: 0,
  };
}

function makeDeps(
  logEntries: ExecutionLogEntry[],
  options?: {
    markets?: ScanSearchResult[];
    books?: Record<string, OrderBook>;
    now?: () => Date;
  },
): NegRiskBuyRunnerDeps {
  const markets = options?.markets ?? MOCK_MARKETS;
  const books = options?.books ?? MOCK_BOOKS;
  let scanCalls = 0;

  const deps: NegRiskBuyRunnerDeps = {
    scan: {
      searchMarkets: vi.fn(async () => {
        scanCalls += 1;
        return scanCalls === 1 ? markets : [];
      }),
      fetchOrderBook: vi.fn(
        async (tokenId: string): Promise<OrderBook> =>
          books[tokenId] ?? { tokenId, asks: [], bids: [] },
      ),
    },
    executor: {
      submit: vi.fn(async () => ({
        id: "ord-neg-001",
        status: "filled",
      })),
    },
    positions: {
      reconcile: vi.fn(async () => makeEmptyPortfolio()),
      getPortfolio: vi.fn(() => makeEmptyPortfolio()),
    },
    log: (entry) => logEntries.push(entry),
  };
  if (options?.now !== undefined) {
    deps.now = options.now;
  }
  return deps;
}

async function runOneCycle(
  runner: { start(): Promise<void>; stop(): void },
): Promise<void> {
  const started = runner.start();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  runner.stop();
  await started;
}

// ---------------------------------------------------------------------------
// Dry-run emission — signals logged, orders NOT submitted
// ---------------------------------------------------------------------------

describe("ARB-03 integration — dry-run emission", () => {
  it("logs signals for a NegRisk arb bundle and does not submit orders", async () => {
    const logEntries: ExecutionLogEntry[] = [];
    const deps = makeDeps(logEntries);

    const runner = createNegRiskBuyRunner(makeConfig(), deps);
    expect(runner.isRunning).toBe(false);

    await runOneCycle(runner);

    // -- Scan layer called with correct category --
    expect(deps.scan.searchMarkets).toHaveBeenCalledWith(
      "NBA Champion",
    );
    expect(deps.scan.fetchOrderBook).toHaveBeenCalledWith("tok-lak");
    expect(deps.scan.fetchOrderBook).toHaveBeenCalledWith("tok-cel");
    expect(deps.scan.fetchOrderBook).toHaveBeenCalledWith("tok-nug");

    // -- Position reconciliation occurred --
    expect(deps.positions.reconcile).toHaveBeenCalled();

    // -- At least one signal entry logged for the arb bundle --
    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries.length).toBeGreaterThan(0);
    for (const entry of signalEntries) {
      expect(entry.automation_id).toBe("arb-negrisk-buy");
      expect(entry.market_id).toBe("cond-arb-neg-001");
    }

    // -- Risk checks ran and approved --
    const riskEntries = logEntries.filter(
      (e) => e.type === "risk_check",
    );
    expect(riskEntries.length).toBeGreaterThan(0);
    for (const entry of riskEntries) {
      expect(entry.data["approved"]).toBe(true);
    }

    // -- Dry-run: executor never invoked --
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("emits no signals when every market is non-NegRisk", async () => {
    const logEntries: ExecutionLogEntry[] = [];
    const markets: ScanSearchResult[] = [
      {
        conditionId: "cond-binary-only",
        question: "Binary market",
        isNegRisk: false,
        legs: [
          { outcome: "YES", tokenId: "tok-bin-y" },
          { outcome: "NO", tokenId: "tok-bin-n" },
        ],
      },
    ];
    const deps = makeDeps(logEntries, { markets, books: {} });

    const runner = createNegRiskBuyRunner(makeConfig(), deps);
    await runOneCycle(runner);

    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries).toHaveLength(0);
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TTL expiry — signals older than signalTtlMs must be dropped
// ---------------------------------------------------------------------------

describe("ARB-03 integration — TTL expiry", () => {
  it("drops signals whose timestamp is older than signalTtlMs", async () => {
    const logEntries: ExecutionLogEntry[] = [];

    // `now` advances 20s between signal generation and the freshness
    // filter, simulating slow downstream processing. TTL is 15s, so
    // the signal must be dropped before reaching the log.
    const t0 = new Date("2026-04-20T12:00:00.000Z");
    const tStale = new Date(t0.getTime() + 20_000);
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(t0)
      .mockReturnValue(tStale);

    const deps = makeDeps(logEntries, { now: clock });

    const runner = createNegRiskBuyRunner(
      makeConfig({
        strategy: {
          category: "NBA Champion",
          feeRate: 0.02,
          gasPerLeg: 0.05,
          hurdleRate: 0.03,
          bankroll: 10_000,
          kellyFraction: 0.15,
          maxExposure: 0.05,
          signalTtlMs: 15_000,
          minLegLiquidity: 300,
          maxLegPriceWithLowLiq: 0.30,
          lowLiqThreshold: 100,
          sumThreshold: 0.97,
        },
      }),
      deps,
    );
    await runOneCycle(runner);

    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries).toHaveLength(0);
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });

  it("keeps signals whose timestamp is within signalTtlMs", async () => {
    const logEntries: ExecutionLogEntry[] = [];

    // `now` advances only 1s — well within 15s TTL — so the signal
    // must survive the freshness filter and reach the log.
    const t0 = new Date("2026-04-20T12:00:00.000Z");
    const tFresh = new Date(t0.getTime() + 1_000);
    const clock = vi
      .fn<() => Date>()
      .mockReturnValueOnce(t0)
      .mockReturnValue(tFresh);

    const deps = makeDeps(logEntries, { now: clock });

    const runner = createNegRiskBuyRunner(makeConfig(), deps);
    await runOneCycle(runner);

    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries.length).toBeGreaterThan(0);
  });
});
