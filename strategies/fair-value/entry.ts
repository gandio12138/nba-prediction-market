/**
 * IA-03 Fair Value Probability Model — Project Entry Point
 *
 * Wires the real Polymarket client into the fair-value strategy:
 *   - `--live`     → submits real CLOB GTC limit orders via `createLiveExecutor`.
 *   - default      → dry-run (production safety: no flag never trades).
 *
 * The bootstrap exposes pure factories (`parseEntryFlags`, `createEntryDeps`,
 * `assertLiveCapabilities`, `buildLiveAllowanceClient`) so unit tests can
 * exercise the wiring without starting the poll loop.
 *
 * The shipped `ProbabilityModel` is a neutral fallback (returns the
 * market price as fair value with zero confidence), so divergence is
 * always 0 and no signals fire. Operators register a real model when
 * deploying — see `strategy.md` for the model interface.
 */

import { pathToFileURL } from "node:url";

import {
  formatBankrollBanner,
  resolveBankroll,
} from "../../bankroll.js";
import { appendEntry } from "../../execution-log.js";
import type { ExecutionLogEntry } from "../../execution-log.js";
import { fetchBinaryMarketSnapshots } from "../../client-polymarket.js";
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

import { DEFAULT_FAIR_VALUE_CONFIG } from "./config.js";
import { createFairValueRunner } from "./main.js";
import type { FairValueRunnerConfig } from "./main.js";
import type {
  FairValueSnapshot,
  ModelContext,
  ModelResult,
  ProbabilityModel,
  ScanDeps,
} from "./scan.js";

/** Approval is refreshed when current allowance drops below this floor. */
const USDC_ALLOWANCE_THRESHOLD = 100_000_000_000n; // 100k USDC (6 decimals)
/** When refreshing, allowance is set to this target. */
const USDC_ALLOWANCE_TARGET = 1_000_000_000_000n; // 1M USDC
/** Fallback price when the signal does not carry market price. */
const FALLBACK_PRICE = 0.5;

/** Parsed CLI flags for the fair-value entry point. */
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

/** Live executor + positions + scan adapters wired for the runner. */
export interface EntryDeps {
  scan: ScanDeps;
  executor: ExecutorDeps;
  positions: PositionDeps;
}

/**
 * Parse `process.argv` into entry flags. `--live` opts in to live
 * execution; `--bankroll <amount>` sets and persists the bankroll
 * (positive USD number); anything else (including no flag) is dry-run.
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
 * Resolve a fair-value signal to (tokenIds, price) for the live executor.
 *
 * IA-03 trades both directions: `buy_yes` when fair > market, `buy_no`
 * when fair < market. The limit price for the YES leg is the market
 * price; the NO leg's price is `1 - market` (binary complement). TIF is
 * GTC (resting limit) — urgency is `normal`, so the order rests on book
 * until filled or cancelled.
 */
function resolveFairValueOrder(signal: TradeSignal): ResolvedOrder {
  const meta = signal.metadata;
  const yesTokenIdRaw = meta["yesTokenId"];
  const noTokenIdRaw = meta["noTokenId"];
  const marketPriceRaw = meta["marketPrice"];

  const yesTokenId =
    typeof yesTokenIdRaw === "string" && yesTokenIdRaw.length > 0
      ? yesTokenIdRaw
      : `${signal.market.market_id}:yes`;
  const noTokenId =
    typeof noTokenIdRaw === "string" && noTokenIdRaw.length > 0
      ? noTokenIdRaw
      : `${signal.market.market_id}:no`;
  const marketPrice =
    typeof marketPriceRaw === "number" ? marketPriceRaw : FALLBACK_PRICE;

  const isNoLeg =
    signal.direction === "buy_no" || signal.direction === "sell_no";
  // Binary complement: NO ≈ 1 - YES. Suitable as a limit-price seed; the
  // book may diverge, so plug in a dedicated NO snapshot when precision
  // matters.
  const price = isNoLeg ? Math.max(0, Math.min(1, 1 - marketPrice)) : marketPrice;

  return {
    tokenIds: { yes: yesTokenId, no: noTokenId },
    price,
    timeInForce: "GTC",
  };
}

/**
 * Default neutral probability model — returns the market price.
 *
 * Confidence is zero, so the divergence/confluence gate in `main.ts`
 * never fires a signal. Operators replace this with a real statistical
 * model (e.g. ELO blend, vegas-line implied probability) before going
 * live with capital.
 */
const NEUTRAL_MODEL: ProbabilityModel = {
  computeFairValue(ctx: ModelContext): ModelResult {
    return {
      fairValue: ctx.snapshot.marketPrice,
      sources: [],
      confidence: 0,
    };
  },
};

/** Optional dependencies for `createEntryDeps`. */
export interface CreateEntryDepsOptions {
  allowance?: AllowanceClient;
  query?: string;
  /** Override the probability model (defaults to the neutral model). */
  model?: ProbabilityModel;
}

/** Build live executor + positions + scan adapters for the runner. */
export function createEntryDeps(
  flags: EntryFlags,
  options: CreateEntryDepsOptions = {},
): EntryDeps {
  void flags;
  const executor = createLiveExecutor({
    resolveOrder: resolveFairValueOrder,
    ...(options.allowance !== undefined ? { allowance: options.allowance } : {}),
    allowanceThreshold: USDC_ALLOWANCE_THRESHOLD,
    allowanceTarget: USDC_ALLOWANCE_TARGET,
  });
  const positions = createLivePositions();
  const query = options.query ?? "";
  const FAR_FUTURE_MS = 365 * 24 * 60 * 60 * 1000;
  const scan: ScanDeps = {
    fetchSnapshots: async (): Promise<FairValueSnapshot[]> => {
      const snapshots = await fetchBinaryMarketSnapshots(query);
      return snapshots.map((s) => ({
        conditionId: s.conditionId,
        question: s.question,
        yesTokenId: s.yesTokenId,
        noTokenId: s.noTokenId,
        marketPrice: s.yesPrice,
        volume24h: s.volume24h,
        openInterest: s.openInterest,
        timeToCloseMs: s.timeToCloseMs ?? FAR_FUTURE_MS,
        timestampMs: s.timestampMs,
      }));
    },
    model: options.model ?? NEUTRAL_MODEL,
  };
  return { scan, executor, positions };
}

/**
 * `--live` start-up safety gate.
 *
 * Delegates to the shared `assertReadyForLive` helper. IA-03 uses GTC
 * limit orders; degrading would convert a passive entry into an
 * aggressive taker.
 */
export async function assertLiveCapabilities(): Promise<void> {
  await assertReadyForLive({
    strategyName: "IA-03",
    requiredTif: "GTC",
  });
}

/** Build a live USDC allowance client from an injected `WalletStore`. */
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
    dryRunDefault: DEFAULT_FAIR_VALUE_CONFIG.bankroll,
    fetchPortfolio: () => positions.reconcile(),
  });
  process.stdout.write(`${formatBankrollBanner(bankroll)}\n`);

  const runnerConfig: FairValueRunnerConfig = {
    strategy: { ...DEFAULT_FAIR_VALUE_CONFIG, bankroll: bankroll.amount },
    runner: {
      pollIntervalMs,
      dryRun: flags.dryRun,
      baseDir: ".",
      statePath: ".canon/state.json",
    },
  };

  const runner = createFairValueRunner(runnerConfig, {
    scan,
    executor,
    positions,
    log: (entry: ExecutionLogEntry) =>
      appendEntry(".", entry),
  });

  process.stdout.write(
    `START IA-03 scanner (${flags.dryRun ? "dry-run" : "live"}) ` +
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
