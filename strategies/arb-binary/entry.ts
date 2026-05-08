/**
 * ARB-01 Binary Arbitrage — Project Entry Point
 *
 * Wires the real Polymarket client into the arb-binary strategy:
 *   - `--live`     → submits real CLOB orders via `createLiveExecutor`.
 *   - `--dry-run`  → runs the full pipeline (scan, signal, risk) but the
 *                    runner skips order submission.
 *   - default      → dry-run (production safety: no flag never trades).
 *
 * The bootstrap exposes pure factories (`parseEntryFlags`, `createEntryRisk`,
 * `createEntryDeps`) so unit tests can exercise the wiring without starting
 * the poll loop. `runner.start()` only fires when the file is the process
 * entry point.
 */

import { pathToFileURL } from "node:url";

import {
  formatBankrollBanner,
  resolveBankroll,
} from "../../bankroll.js";
import { appendEntry } from "../../execution-log.js";
import { FileWalletStore } from "../../wallet-store.js";
import type { WalletStore } from "../../wallet-store.js";
import {
  fetchOrderBook,
  searchMarkets,
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
import { createRunner } from "../../runner.js";
import type {
  ExecutorDeps,
  OnOutcome,
  PositionDeps,
} from "../../runner.js";
import { createUsdcAllowanceClient } from "../../usdc-allowance.js";
import type { ExecutionLogEntry } from "../../execution-log.js";
import type { TradeSignal } from "../../types/TradeSignal.js";

import { DEFAULT_ARB_BINARY_CONFIG } from "./config.js";
import type { ArbBinaryRisk } from "./risk.js";
import { createRiskChecker } from "./risk.js";
import { scanMarkets } from "./scan.js";
import { detectSignals } from "./signal.js";

/** Approval is refreshed when current allowance drops below this floor. */
const USDC_ALLOWANCE_THRESHOLD = 100_000_000_000n; // 100k USDC (6 decimals)
/** When refreshing, allowance is set to this target. */
const USDC_ALLOWANCE_TARGET = 1_000_000_000_000n; // 1M USDC
/** Circuit breaker threshold — halts after this many consecutive losses. */
const MAX_CONSECUTIVE_LOSSES = 3;
/** Fallback price when the signal does not carry an order-book ask. */
const FALLBACK_PRICE = 0.5;

/** Parsed CLI flags for the arb-binary entry point. */
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
 * Build the ARB-01 risk checker with the production circuit-breaker.
 *
 * `bankroll` defaults to the config default so existing call sites
 * (and tests) continue to work; `main()` passes the resolved live
 * bankroll from `.canon/bankroll.json`.
 */
export function createEntryRisk(
  bankroll: number = DEFAULT_ARB_BINARY_CONFIG.bankroll,
): ArbBinaryRisk {
  return createRiskChecker({
    bankroll,
    kellyFraction: DEFAULT_ARB_BINARY_CONFIG.kellyFraction,
    maxExposure: DEFAULT_ARB_BINARY_CONFIG.maxExposure,
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
  });
}

/**
 * Build the runner outcome callback for ARB-01.
 *
 * Win/loss accounting for the consecutive-loss circuit breaker
 * (Q-2, decision (a) "both legs filled = win"):
 *
 * - `rejected` / `error` — record a loss and discard any pending
 *   leg state for that market (the pair is already broken).
 * - `submitted` — track which leg (yes/no) of the market filled.
 *   Once both legs of the same market reach `submitted`, record a
 *   win and reset the per-market state. A single leg in isolation
 *   records nothing — it is neither a win (pair incomplete) nor a
 *   loss (the leg itself succeeded).
 *
 * Per-market tracking lives in a closure-scoped Map so the runner's
 * onOutcome callback observes leg pairs across the synchronous
 * processing of a cycle's signals. See
 * `docs/reviews/261-open-questions.md`, Q-2.
 */
export function createEntryOnOutcome(risk: ArbBinaryRisk): OnOutcome {
  const filledLegs = new Map<string, Set<"yes" | "no">>();
  return (outcome) => {
    const marketId = outcome.signal.market.market_id;
    if (outcome.status === "rejected" || outcome.status === "error") {
      filledLegs.delete(marketId);
      risk.recordOutcome(false);
      return;
    }
    if (outcome.status !== "submitted") return;

    const direction = outcome.signal.direction;
    const leg: "yes" | "no" =
      direction === "buy_yes" || direction === "sell_yes" ? "yes" : "no";

    const seen = filledLegs.get(marketId) ?? new Set<"yes" | "no">();
    seen.add(leg);
    if (seen.has("yes") && seen.has("no")) {
      filledLegs.delete(marketId);
      risk.recordOutcome(true);
      return;
    }
    filledLegs.set(marketId, seen);
  };
}

/**
 * Resolve a TradeSignal to the (tokenIds, price) pair the live executor needs.
 *
 * The scan layer attaches yesAsk/noAsk and the YES/NO CLOB token IDs to the
 * signal metadata. The fallback path keeps unit tests and ad-hoc replays
 * functional when metadata is partial.
 */
function resolveArbBinaryOrder(signal: TradeSignal): ResolvedOrder {
  const meta = signal.metadata;
  const yesTokenIdRaw = meta["yesTokenId"];
  const noTokenIdRaw = meta["noTokenId"];
  const yesAskRaw = meta["yesAsk"];
  const noAskRaw = meta["noAsk"];

  const yesTokenId =
    typeof yesTokenIdRaw === "string" && yesTokenIdRaw.length > 0
      ? yesTokenIdRaw
      : `${signal.market.market_id}:yes`;
  const noTokenId =
    typeof noTokenIdRaw === "string" && noTokenIdRaw.length > 0
      ? noTokenIdRaw
      : `${signal.market.market_id}:no`;
  const yesAsk = typeof yesAskRaw === "number" ? yesAskRaw : FALLBACK_PRICE;
  const noAsk = typeof noAskRaw === "number" ? noAskRaw : FALLBACK_PRICE;

  const isYesLeg =
    signal.direction === "buy_yes" || signal.direction === "sell_yes";

  return {
    tokenIds: { yes: yesTokenId, no: noTokenId },
    price: isYesLeg ? yesAsk : noAsk,
    // FOK kills the leg if it can't fully execute, preventing
    // one-sided exposure between the YES and NO legs.
    timeInForce: "FOK",
  };
}

/**
 * Optional dependencies for `createEntryDeps`.
 *
 * `allowance` is an injection seam — `main()` builds a real
 * `createUsdcAllowanceClient` for `--live`, while tests inject a
 * fake `AllowanceClient` to assert the live executor consults it
 * before submitting (Q-3).
 */
export interface CreateEntryDepsOptions {
  allowance?: AllowanceClient;
}

/**
 * Build the live executor + position adapters consumed by the runner.
 *
 * Both adapters are always live — the runner gates `executor.submit` on
 * `config.dryRun`, so dry-run still exercises the wiring without sending
 * orders. When `options.allowance` is provided, the live executor will
 * read it before each submit and top up to `USDC_ALLOWANCE_TARGET` when
 * the cached value falls below `USDC_ALLOWANCE_THRESHOLD`.
 */
export function createEntryDeps(
  flags: EntryFlags,
  options: CreateEntryDepsOptions = {},
): EntryDeps {
  void flags;
  const executor = createLiveExecutor({
    resolveOrder: resolveArbBinaryOrder,
    ...(options.allowance !== undefined ? { allowance: options.allowance } : {}),
    allowanceThreshold: USDC_ALLOWANCE_THRESHOLD,
    allowanceTarget: USDC_ALLOWANCE_TARGET,
  });
  const positions = createLivePositions();
  return { executor, positions };
}

/**
 * `--live` start-up safety gate (Q-5).
 *
 * Delegates to the shared `assertReadyForLive` helper. ARB-01 relies on
 * FOK to keep YES/NO legs synchronised; silently degrading to a regular
 * limit order would expose the strategy to one-sided fills.
 */
export async function assertLiveCapabilities(): Promise<void> {
  await assertReadyForLive({
    strategyName: "ARB-01",
    requiredTif: "FOK",
    tifReason: "See docs/reviews/261-open-questions.md (Q-5).",
  });
}

/**
 * Build a live USDC allowance client from an injected `WalletStore`.
 *
 * The wallet store owns key storage (canon's `.canon/wallet.env` by
 * default; pluggable for Keychain / hardware backends). The templates
 * layer never touches private keys directly — it asks the store.
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
    // WalletNotFoundError or any signer-side failure — surface as
    // "no allowance adapter" so main() falls back to manual approval
    // rather than crashing the strategy boot.
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
    wallet !== undefined
      ? await buildLiveAllowanceClient(wallet)
      : undefined;
  const { executor, positions } = createEntryDeps(
    flags,
    allowance !== undefined ? { allowance } : {},
  );

  const bankroll = await resolveBankroll({
    override: flags.bankroll,
    dryRun: flags.dryRun,
    dryRunDefault: DEFAULT_ARB_BINARY_CONFIG.bankroll,
    fetchPortfolio: () => positions.reconcile(),
  });
  process.stdout.write(`${formatBankrollBanner(bankroll)}\n`);

  const risk = createEntryRisk(bankroll.amount);
  const strategy = async (): Promise<TradeSignal[]> => {
    const marketData = await scanMarkets(
      { ...DEFAULT_ARB_BINARY_CONFIG, bankroll: bankroll.amount },
      { searchMarkets, fetchOrderBook },
    );
    return detectSignals(marketData, {
      ...DEFAULT_ARB_BINARY_CONFIG,
      bankroll: bankroll.amount,
    });
  };

  const onOutcome = createEntryOnOutcome(risk);

  const runner = createRunner(
    {
      pollIntervalMs,
      dryRun: flags.dryRun,
      baseDir: ".",
      statePath: ".canon/state.json",
    },
    {
      strategy,
      risk,
      executor,
      positions,
      log: (entry: ExecutionLogEntry) =>
        appendEntry(".", entry),
      onOutcome,
    },
  );

  process.stdout.write(
    `START ARB-01 scanner (${flags.dryRun ? "dry-run" : "live"}) ` +
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
