import { describe, it, expect, vi } from "vitest";
import { createArbBinaryRunner } from "../main.js";
import type {
  ArbBinaryRunnerConfig,
  ArbBinaryRunnerDeps,
} from "../main.js";
import type { ExecutionLogEntry } from "../../../execution-log.js";
import type { OrderBook } from "../../../client-polymarket.js";
import type { ScanSearchResult } from "../scan.js";
import type { Portfolio } from "../../../types/RiskInterface.js";

// ---------------------------------------------------------------------------
// Hardcoded mock API data — NBA market with a clear arb edge
// YES=0.40 + NO=0.40 = 0.80 < 1.00 → guaranteed profit
// ---------------------------------------------------------------------------

const MOCK_MARKETS: ScanSearchResult[] = [
  {
    conditionId: "cond-arb-001",
    question: "Will the Lakers win Game 7?",
    yesTokenId: "tok-yes-arb",
    noTokenId: "tok-no-arb",
  },
];

const MOCK_BOOKS: Record<string, OrderBook> = {
  "tok-yes-arb": {
    tokenId: "tok-yes-arb",
    asks: [{ price: 0.4, size: 500 }],
    bids: [{ price: 0.399, size: 300 }],
  },
  "tok-no-arb": {
    tokenId: "tok-no-arb",
    asks: [{ price: 0.4, size: 500 }],
    bids: [{ price: 0.399, size: 300 }],
  },
};

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function makeConfig(
  overrides?: Partial<ArbBinaryRunnerConfig>,
): ArbBinaryRunnerConfig {
  return {
    strategy: {
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
    runner: {
      pollIntervalMs: 10,
      dryRun: true,
      baseDir: "/tmp/arb-test",
      statePath: "/tmp/arb-test/state.json",
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

// ---------------------------------------------------------------------------
// Integration test — full pipeline
// ---------------------------------------------------------------------------

describe("ARB-01 integration — full pipeline", () => {
  it("signals pass through risk checks and get logged", async () => {
    const logEntries: ExecutionLogEntry[] = [];

    // Return markets only on the first scan call so subsequent
    // poll cycles produce no signals and no extra log entries.
    let scanCalls = 0;
    const deps: ArbBinaryRunnerDeps = {
      scan: {
        searchMarkets: vi.fn(async () => {
          scanCalls += 1;
          return scanCalls === 1 ? MOCK_MARKETS : [];
        }),
        fetchOrderBook: vi.fn(
          async (tokenId: string): Promise<OrderBook> =>
            MOCK_BOOKS[tokenId] ?? {
              tokenId,
              asks: [],
              bids: [],
            },
        ),
      },
      executor: {
        submit: vi.fn(async () => ({
          id: "ord-001",
          status: "filled",
        })),
      },
      positions: {
        reconcile: vi.fn(async () => makeEmptyPortfolio()),
        getPortfolio: vi.fn(() => makeEmptyPortfolio()),
      },
      log: (entry) => logEntries.push(entry),
    };

    const runner = createArbBinaryRunner(makeConfig(), deps);

    // Runner instance created successfully
    expect(runner).toBeDefined();
    expect(runner.isRunning).toBe(false);

    // Run one cycle then stop
    const started = runner.start();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    runner.stop();
    await started;

    // -- Scan layer called with correct category --
    expect(deps.scan.searchMarkets).toHaveBeenCalledWith("NBA");
    expect(deps.scan.fetchOrderBook).toHaveBeenCalledWith(
      "tok-yes-arb",
    );
    expect(deps.scan.fetchOrderBook).toHaveBeenCalledWith(
      "tok-no-arb",
    );

    // -- Position reconciliation occurred --
    expect(deps.positions.reconcile).toHaveBeenCalled();

    // -- Two signals logged: buy_yes + buy_no --
    const signalEntries = logEntries.filter(
      (e) => e.type === "signal",
    );
    expect(signalEntries).toHaveLength(2);

    const directions = signalEntries.map(
      (e) => e.data["direction"],
    );
    expect(directions).toContain("buy_yes");
    expect(directions).toContain("buy_no");

    // Both signals target the correct market
    for (const entry of signalEntries) {
      expect(entry.automation_id).toBe("arb-binary");
      expect(entry.market_id).toBe("cond-arb-001");
    }

    // -- Two risk checks logged — both approved --
    const riskEntries = logEntries.filter(
      (e) => e.type === "risk_check",
    );
    expect(riskEntries).toHaveLength(2);
    expect(riskEntries[0]!.data["approved"]).toBe(true);
    expect(riskEntries[1]!.data["approved"]).toBe(true);

    // -- Dry-run: orders NOT submitted --
    expect(deps.executor.submit).not.toHaveBeenCalled();
  });
});
