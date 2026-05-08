/**
 * MINT-01 Simple Mint Cycle — Project Entry Point
 *
 * Bootstrap module that wires the live Polymarket client and CTF mint
 * adapter into the MINT-01 strategy:
 *
 *   - `--live`     → submits real CLOB sell limits via `createLiveExecutor`
 *                    and mints YES + NO pairs via `ctf-mint.splitPosition`.
 *   - `--dry-run`  → exercises the full pipeline without sending orders or
 *                    on-chain transactions.
 *   - default      → dry-run (production safety: no flag never trades).
 *
 * Mirrors the ARB-01 bootstrap shape (`parseEntryFlags`, `createEntryDeps`,
 * `assertLiveCapabilities`, `buildLiveAllowanceClient`) so the same
 * `WalletStore` injection pattern carries over with no new top-level
 * adapters. Reviewer hooks called from production:
 *
 *   - `selectMarket`  / `planLegs`  — exposed pure helpers from `cycle.ts`,
 *     re-invoked here as `detectMint01Candidate` to produce a CLOB-shaped
 *     pair of TradeSignals (one sell_yes, one sell_no).
 *   - `signalToOrderParams` — reused from `order-executor.ts` via the
 *     shared `live-executor` to keep the integration trace single-source.
 */
import { pathToFileURL } from "node:url";

import { assertReadyForLive } from "../../live-preflight.js";
import { createLiveExecutor } from "../../live-executor.js";
import type {
  AllowanceClient,
  LiveExecutor,
  ResolvedOrder,
} from "../../live-executor.js";
import {
  CTF_EXCHANGE_ADDRESS,
  USDC_E_ADDRESS,
} from "../../polygon-addresses.js";
import { createUsdcAllowanceClient } from "../../usdc-allowance.js";
import type { TradeSignal } from "../../types/TradeSignal.js";
import { FileWalletStore } from "../../wallet-store.js";
import type { WalletStore } from "../../wallet-store.js";

import { DEFAULT_MINT_01_CONFIG } from "./config.js";
import type { Mint01Config } from "./config.js";
import {
  planLegs,
  selectMarket,
} from "./cycle.js";
import type { CycleLegs, MarketCandidate, MarketChoice } from "./cycle.js";

/** Allowance is refreshed when the cached value drops below this floor. */
const USDC_ALLOWANCE_THRESHOLD = 100_000_000_000n; // 100k USDC.e (6 decimals)
/** When refreshing, allowance is set to this target. */
const USDC_ALLOWANCE_TARGET = 1_000_000_000_000n; // 1M USDC.e

/** Parsed CLI flags for the MINT-01 entry point. */
export interface EntryFlags {
  /** When true, the bootstrap exercises the wiring without submitting. */
  dryRun: boolean;
}

/**
 * Parse `process.argv` into entry flags.
 *
 * `--live` flips to live execution. Anything else (including `--dry-run` or
 * no flag) keeps the safe dry-run default.
 */
export function parseEntryFlags(argv: readonly string[]): EntryFlags {
  if (argv.includes("--live")) return { dryRun: false };
  return { dryRun: true };
}

/**
 * Detect a MINT-01 candidate and emit the two-leg sell-limit signal pair.
 *
 * Composes `selectMarket → planLegs → TradeSignal[]` so the integration
 * trace flows entirely through exposed pure helpers. Returns `null` when
 * no candidate passes the filter gate.
 */
export interface Mint01Candidate {
  /** Market that won the rank in `selectMarket`. */
  choice: MarketChoice;
  /** Legs derived from `planLegs(choice.candidate.midpoint, config)`. */
  legs: CycleLegs;
  /** Two TradeSignals: `[sell_yes, sell_no]` ready for the executor. */
  signals: [TradeSignal, TradeSignal];
}

export function detectMint01Candidate(
  candidates: MarketCandidate[],
  config: Mint01Config = DEFAULT_MINT_01_CONFIG,
): Mint01Candidate | null {
  const choice = selectMarket(candidates, config);
  if (choice === null) return null;
  const legs = planLegs(choice.candidate.midpoint, config);

  // selectMarket guarantees both token ids are present.
  const yesTokenId = choice.candidate.yesTokenId as string;
  const noTokenId = choice.candidate.noTokenId as string;

  const now = new Date();
  const market: TradeSignal["market"] = {
    platform: "polymarket",
    market_id: choice.candidate.conditionId,
    question: choice.candidate.question,
  };
  const baseMetadata: Record<string, unknown> = {
    yesTokenId,
    noTokenId,
    yesPrice: legs.yesPrice,
    noPrice: legs.noPrice,
    entryMidpoint: choice.candidate.midpoint,
    timeInForce: config.timeInForce,
  };

  const yesSignal: TradeSignal = {
    automation_id: "mint-01",
    timestamp: now,
    market,
    direction: "sell_yes",
    size: legs.size,
    confidence: 1,
    urgency: "normal",
    metadata: { ...baseMetadata, leg: "yes" },
  };
  const noSignal: TradeSignal = {
    automation_id: "mint-01",
    timestamp: now,
    market: { ...market },
    direction: "sell_no",
    size: legs.size,
    confidence: 1,
    urgency: "normal",
    metadata: { ...baseMetadata, leg: "no" },
  };

  return { choice, legs, signals: [yesSignal, noSignal] };
}

/**
 * Resolve a MINT-01 TradeSignal to the `(tokenIds, price, tif)` triple the
 * live executor needs. Reads token ids and the per-leg price out of the
 * signal metadata produced by `detectMint01Candidate`.
 */
export function resolveMint01Order(signal: TradeSignal): ResolvedOrder {
  const meta = signal.metadata;
  const yesTokenId = meta["yesTokenId"];
  const noTokenId = meta["noTokenId"];
  if (typeof yesTokenId !== "string" || yesTokenId.length === 0) {
    throw new Error("mint-01: signal.metadata.yesTokenId missing");
  }
  if (typeof noTokenId !== "string" || noTokenId.length === 0) {
    throw new Error("mint-01: signal.metadata.noTokenId missing");
  }

  const isYesLeg = signal.direction === "sell_yes";
  const priceKey = isYesLeg ? "yesPrice" : "noPrice";
  const priceRaw = meta[priceKey];
  if (typeof priceRaw !== "number") {
    throw new Error(`mint-01: signal.metadata.${priceKey} must be a number`);
  }
  const tifRaw = meta["timeInForce"];
  const timeInForce: "GTC" | "FOK" =
    tifRaw === "FOK" ? "FOK" : "GTC";

  return {
    tokenIds: { yes: yesTokenId, no: noTokenId },
    price: priceRaw,
    timeInForce,
  };
}

/** Optional dependencies for `createEntryDeps`. */
export interface CreateEntryDepsOptions {
  /** Inject a fake `AllowanceClient` to assert the executor consults it. */
  allowance?: AllowanceClient;
}

/** Live executor returned by `createEntryDeps`. */
export interface EntryDeps {
  executor: LiveExecutor;
}

/**
 * Build the live executor consumed by the MINT-01 cycle.
 *
 * Both legs are resolved by `resolveMint01Order` (same module), so the
 * executor produces CLOB-shaped order params for either `sell_yes` or
 * `sell_no` based on `signal.direction`. When `options.allowance` is
 * provided, the executor consults it before each submit and tops up
 * to `USDC_ALLOWANCE_TARGET` when below `USDC_ALLOWANCE_THRESHOLD`.
 */
export function createEntryDeps(
  flags: EntryFlags,
  options: CreateEntryDepsOptions = {},
): EntryDeps {
  void flags;
  const executor = createLiveExecutor({
    resolveOrder: resolveMint01Order,
    ...(options.allowance !== undefined ? { allowance: options.allowance } : {}),
    allowanceThreshold: USDC_ALLOWANCE_THRESHOLD,
    allowanceTarget: USDC_ALLOWANCE_TARGET,
  });
  return { executor };
}

/**
 * `--live` start-up safety gate.
 *
 * MINT-01 places GTC sell limits — strictly speaking, GTC works on any
 * sidecar — but the same `supportsTif` check applies because the
 * executor forwards `timeInForce` regardless. A sidecar that drops `tif`
 * would silently default to whatever the exchange default is, breaking
 * the per-leg semantics this strategy depends on.
 */
export async function assertLiveCapabilities(): Promise<void> {
  await assertReadyForLive({
    strategyName: "MINT-01",
    requiredTif: "GTC",
    tifReason: "See docs/reviews/261-open-questions.md (Q-5).",
  });
}

/**
 * Build a live USDC allowance client from an injected `WalletStore`.
 *
 * Mirrors the ARB-01 bootstrap edge: the templates layer never imports
 * `canon/cli` at compile time; the `WalletStore` is supplied by `main()`
 * at runtime. Returns `undefined` when the store has no wallet or when
 * resolving the address fails — `main()` then skips allowance plumbing.
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
    spenderAddress: CTF_EXCHANGE_ADDRESS,
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
  const deps = createEntryDeps(
    flags,
    allowance !== undefined ? { allowance } : {},
  );

  process.stdout.write(
    `START MINT-01 cycle (${flags.dryRun ? "dry-run" : "live"})\n`,
  );

  // The live cycle loop (scan → splitPosition → submit two legs → poll
  // for fills + stop-loss) is wired in a follow-up runner change. For
  // now `deps.executor` is the production seam exercised by tests.
  void deps;
}

const entryArg = process.argv[1];
const isMain =
  entryArg !== undefined &&
  import.meta.url === pathToFileURL(entryArg).href;

if (isMain) {
  void main();
}
