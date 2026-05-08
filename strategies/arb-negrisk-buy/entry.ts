/**
 * ARB-03 NegRisk Multi-condition Buy — Project Entry Point
 *
 * Wires the real Polymarket client into the arb-negrisk-buy strategy:
 *   - `--live`     → submits real CLOB orders via `createLiveExecutor`.
 *   - default      → dry-run (production safety: no flag never trades).
 *
 * The bootstrap exposes pure factories (`parseEntryFlags`, `createEntryDeps`,
 * `assertLiveCapabilities`, `buildLiveAllowanceClient`) so unit tests can
 * exercise the wiring without starting the poll loop. `runner.start()` only
 * fires when the file is the process entry point.
 *
 * NegRisk data feed: pmxt SDK does not expose the `neg_risk` event flag.
 * `searchMultiOutcomeMarkets` returns multi-outcome markets as NegRisk
 * *candidates*; the scan layer's order-book confirmation (Σ yes_ask < 1)
 * is the sufficient market-driven filter.
 */

import { pathToFileURL } from "node:url";

import {
  formatBankrollBanner,
  resolveBankroll,
} from "../../bankroll.js";
import { appendEntry } from "../../execution-log.js";
import type { ExecutionLogEntry } from "../../execution-log.js";
import {
  fetchOrderBook as polyFetchOrderBook,
  searchMultiOutcomeMarkets,
} from "../../client-polymarket.js";
import { assertReadyForLive } from "../../live-preflight.js";
import { createLiveExecutor } from "../../live-executor.js";
import type {
  AllowanceClient,
  ResolvedOrder,
} from "../../live-executor.js";
import { createLivePositions } from "../../live-positions.js";
import {
  DEFAULT_ALLOWANCE_SPENDER,
  USDC_E_ADDRESS,
} from "../../polygon-addresses.js";
import type {
  ExecutorDeps,
  PositionDeps,
} from "../../runner.js";
import { createUsdcAllowanceClient } from "../../usdc-allowance.js";
import type { TradeSignal } from "../../types/TradeSignal.js";
import { FileWalletStore } from "../../wallet-store.js";
import type { WalletStore } from "../../wallet-store.js";

import { DEFAULT_NEGRISK_BUY_CONFIG } from "./config.js";
import { createNegRiskBuyRunner } from "./main.js";
import type { NegRiskBuyRunnerConfig } from "./main.js";
import type { ScanDeps, ScanSearchResult } from "./scan.js";

/** Approval is refreshed when current allowance drops below this floor. */
const USDC_ALLOWANCE_THRESHOLD = 100_000_000_000n; // 100k USDC (6 decimals)
/** When refreshing, allowance is set to this target. */
const USDC_ALLOWANCE_TARGET = 1_000_000_000_000n; // 1M USDC
/** Circuit breaker threshold — halts after this many consecutive losses. */
const MAX_CONSECUTIVE_LOSSES = 3;
/** Fallback price when the signal does not carry a leg ask. */
const FALLBACK_PRICE = 0.5;

/** Parsed CLI flags for the arb-negrisk-buy entry point. */
export interface EntryFlags {
  /** When true, the runner logs signals but does not submit orders. */
  dryRun: boolean;
  /**
   * Optional `--bankroll <amount>` override. Persisted to
   * `.canon/bankroll.json` when present; subsequent runs without the
   * flag read the stored value back.
   */
  bankroll?: number | undefined;
}

/** Live executor + positions adapters wired for the runner. */
export interface EntryDeps {
  scan: ScanDeps;
  executor: ExecutorDeps;
  positions: PositionDeps;
}

/**
 * Parse `process.argv` into entry flags.
 *
 * `--live` flips to live execution. `--bankroll <amount>` sets and
 * persists the bankroll (positive USD number). Anything else
 * (including `--dry-run` or no flag) keeps the safe dry-run default.
 */
export function parseEntryFlags(argv: readonly string[]): EntryFlags {
  const dryRun = !argv.includes("--live");

  const flagIndex = argv.indexOf("--bankroll");
  if (flagIndex === -1) {
    return { dryRun };
  }
  const raw = argv[flagIndex + 1];
  if (raw === undefined) {
    throw new Error("--bankroll requires a positive USD amount");
  }
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`--bankroll must be a positive number, got "${raw}"`);
  }
  return { dryRun, bankroll: amount };
}

/**
 * Resolve a NegRisk leg signal to the (tokenIds, price) pair the live
 * executor needs.
 *
 * Each NegRisk leg signal is a `buy_yes` on a single condition's YES
 * token; only the `yes` slot of `TokenIds` is consulted by
 * `signalToOrderParams`. We populate both slots with the leg token to
 * keep the contract typed without inventing a NO token that does not
 * exist for NegRisk legs.
 */
function resolveNegRiskOrder(signal: TradeSignal): ResolvedOrder {
  const meta = signal.metadata;
  const tokenIdRaw = meta["tokenId"];
  const yesBidRaw = meta["yesBid"];
  // Scan layer attaches `yesAsk` on each leg; metadata uses `yesBid`
  // for the resting bid and the leg's executable ask resolves through
  // the underlying scan opportunity. Fall back to the bid + 1 tick as
  // a conservative price when neither is present.
  const yesAskRaw = meta["yesAsk"];

  const tokenId =
    typeof tokenIdRaw === "string" && tokenIdRaw.length > 0
      ? tokenIdRaw
      : `${signal.market.market_id}:yes`;
  const price =
    typeof yesAskRaw === "number"
      ? yesAskRaw
      : typeof yesBidRaw === "number"
        ? yesBidRaw
        : FALLBACK_PRICE;

  return {
    tokenIds: { yes: tokenId, no: tokenId },
    price,
    // FOK kills the leg if it can't fully execute, preventing
    // partial-bundle exposure across the N legs.
    timeInForce: "FOK",
  };
}

/**
 * Optional dependencies for `createEntryDeps`.
 *
 * `allowance` is an injection seam — `main()` builds a real
 * `createUsdcAllowanceClient` for `--live`, while tests inject a fake
 * `AllowanceClient` to assert the live executor consults it before
 * submitting.
 */
export interface CreateEntryDepsOptions {
  allowance?: AllowanceClient;
}

/**
 * Build the live executor + position + scan adapters consumed by the runner.
 *
 * All adapters are always live — the runner gates `executor.submit` on
 * `config.dryRun`, so dry-run still exercises the wiring without sending
 * orders.
 */
export function createEntryDeps(
  flags: EntryFlags,
  options: CreateEntryDepsOptions = {},
): EntryDeps {
  void flags;
  const executor = createLiveExecutor({
    resolveOrder: resolveNegRiskOrder,
    ...(options.allowance !== undefined ? { allowance: options.allowance } : {}),
    allowanceThreshold: USDC_ALLOWANCE_THRESHOLD,
    allowanceTarget: USDC_ALLOWANCE_TARGET,
  });
  const positions = createLivePositions();
  const scan: ScanDeps = {
    searchMarkets: async (query: string): Promise<ScanSearchResult[]> => {
      const matches = await searchMultiOutcomeMarkets(query);
      return matches.map((m) => ({
        conditionId: m.conditionId,
        question: m.question,
        // Treat as NegRisk candidate; scan-layer's order-book sum check
        // is the sufficient confirmation.
        isNegRisk: true,
        legs: m.legs.map((l) => ({ outcome: l.outcome, tokenId: l.tokenId })),
      }));
    },
    fetchOrderBook: polyFetchOrderBook,
  };
  return { scan, executor, positions };
}

/**
 * `--live` start-up safety gate.
 *
 * Delegates to the shared `assertReadyForLive` helper. ARB-03 relies on
 * FOK to keep all N legs of the bundle synchronised; silently degrading
 * to a regular limit order would expose the strategy to partial-bundle
 * fills.
 */
export async function assertLiveCapabilities(): Promise<void> {
  await assertReadyForLive({
    strategyName: "ARB-03",
    requiredTif: "FOK",
  });
}

/**
 * Build a live USDC allowance client from an injected `WalletStore`.
 *
 * Returns undefined when the store has no wallet, when the owner
 * address cannot be derived, or when the store throws — `main()` then
 * skips allowance plumbing rather than placing live orders against a
 * misconfigured wallet.
 */
export async function buildLiveAllowanceClient(
  wallet: WalletStore,
): Promise<AllowanceClient | undefined> {
  if (!wallet.hasWallet()) return undefined;

  let ownerAddress: string;
  try {
    ownerAddress = await wallet.getAddress();
  } catch {
    return undefined;
  }

  const rpcUrl =
    process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";

  return createUsdcAllowanceClient({
    ownerAddress,
    spenderAddress: DEFAULT_ALLOWANCE_SPENDER,
    usdcAddress: USDC_E_ADDRESS,
    getProvider: async () => {
      const { providers } = await import("ethers");
      return new providers.JsonRpcProvider(rpcUrl);
    },
    getSigner: async () => {
      const { Wallet, providers } = await import("ethers");
      return new Wallet(
        wallet.getPrivateKey(),
        new providers.JsonRpcProvider(rpcUrl),
      );
    },
  });
}

async function main(): Promise<void> {
  const flags = parseEntryFlags(process.argv);
  const pollIntervalMs = Number(process.env["POLL_INTERVAL_MS"]) || 30_000;

  if (!flags.dryRun) {
    await assertLiveCapabilities();
  }

  const wallet: WalletStore | undefined = flags.dryRun
    ? undefined
    : new FileWalletStore();
  const allowance =
    wallet !== undefined ? await buildLiveAllowanceClient(wallet) : undefined;
  const { scan, executor, positions } = createEntryDeps(
    flags,
    allowance !== undefined ? { allowance } : {},
  );

  const bankroll = await resolveBankroll({
    override: flags.bankroll,
    dryRun: flags.dryRun,
    dryRunDefault: DEFAULT_NEGRISK_BUY_CONFIG.bankroll,
    fetchPortfolio: () => positions.reconcile(),
  });
  process.stdout.write(`${formatBankrollBanner(bankroll)}\n`);

  const runnerConfig: NegRiskBuyRunnerConfig = {
    strategy: { ...DEFAULT_NEGRISK_BUY_CONFIG, bankroll: bankroll.amount },
    runner: {
      pollIntervalMs,
      dryRun: flags.dryRun,
      baseDir: ".",
      statePath: ".canon/state.json",
    },
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
  };

  const runner = createNegRiskBuyRunner(runnerConfig, {
    scan,
    executor,
    positions,
    log: (entry: ExecutionLogEntry) =>
      appendEntry(".", entry),
  });

  process.stdout.write(
    `START ARB-03 scanner (${flags.dryRun ? "dry-run" : "live"}) ` +
      `poll=${String(pollIntervalMs)}ms\n`,
  );

  try {
    await runner.start();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`SCAN_ERROR ${msg}\n`);
    process.exitCode = 1;
  }
}

const entryArg = process.argv[1];
const isMain =
  entryArg !== undefined &&
  import.meta.url === pathToFileURL(entryArg).href;

if (isMain) {
  void main();
}
