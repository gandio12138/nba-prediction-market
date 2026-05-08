/**
 * Persisted bankroll for the trading pipeline.
 *
 * The bankroll governs sizing math (signal size, per-position cap,
 * aggregate cap) and is set once per project then read on every run.
 * Resolution order:
 *   1. Explicit override (e.g. `--bankroll <amount>`) — persisted, source: "user".
 *   2. Existing `.canon/bankroll.json` — read as-is.
 *   3. Dry-run with no file — config default, source: "default-dry-run", not persisted.
 *   4. Live with no file — Polymarket portfolio total_value, persisted, source: "balance-init".
 *
 * Once persisted the value is never auto-updated; profits and losses
 * accrue against the live balance separately. Operators reset by
 * passing `--bankroll <amount>` again or deleting the file.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { Portfolio } from "./types/RiskInterface.js";

/** Default location relative to the project root. */
export const DEFAULT_BANKROLL_PATH = ".canon/bankroll.json";

/** How the persisted bankroll value was originally produced. */
export type BankrollSource = "user" | "balance-init" | "default-dry-run";

/** Persisted bankroll record. */
export interface Bankroll {
  /** Bankroll amount in USD. */
  amount: number;
  /** Settlement currency (always USDC for Polymarket). */
  currency: "USDC";
  /** How this value was set. */
  source: BankrollSource;
  /** ISO 8601 timestamp of when the value was set. */
  setAt: string;
}

const VALID_SOURCES: ReadonlySet<BankrollSource> = new Set<BankrollSource>([
  "user",
  "balance-init",
  "default-dry-run",
]);

/**
 * Validate that a value conforms to the Bankroll schema.
 *
 * Used when reading `.canon/bankroll.json` — an invalid file is treated
 * as missing so the resolution flow can re-init from balance.
 */
export function validateBankroll(value: unknown): value is Bankroll {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["amount"] !== "number" || !Number.isFinite(obj["amount"])) {
    return false;
  }
  if (obj["amount"] <= 0) return false;
  if (obj["currency"] !== "USDC") return false;
  if (
    typeof obj["source"] !== "string" ||
    !VALID_SOURCES.has(obj["source"] as BankrollSource)
  ) {
    return false;
  }
  if (typeof obj["setAt"] !== "string") return false;
  return true;
}

/**
 * Load `.canon/bankroll.json` if present and valid; otherwise return null.
 *
 * Does not throw on missing or malformed files — callers should treat
 * null as "no bankroll set yet" and fall through to init.
 */
export function loadBankroll(path: string): Bankroll | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!validateBankroll(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomically write `.canon/bankroll.json`.
 *
 * Creates parent directories as needed. Uses write-to-temp-then-rename
 * so a crash mid-write cannot corrupt the file.
 */
export function saveBankroll(path: string, bankroll: Bankroll): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(bankroll, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Operator-facing announcement of the active bankroll. */
export function formatBankrollBanner(bankroll: Bankroll): string {
  const date = bankroll.setAt.slice(0, 10);
  const amount = bankroll.amount.toFixed(2);
  switch (bankroll.source) {
    case "user":
      return `BANKROLL=$${amount} (set by --bankroll on ${date})`;
    case "balance-init":
      return (
        `BANKROLL=$${amount} (initialized from Polymarket balance on ${date}` +
        ` — pass --bankroll <amount> to override)`
      );
    case "default-dry-run":
      return `BANKROLL=$${amount} (dry-run default)`;
  }
}

/** Inputs for `resolveBankroll`. */
export interface ResolveBankrollOptions {
  /** Explicit override from `--bankroll <amount>`. Wins over stored file. */
  override?: number | undefined;
  /** True for dry-run, false for live. Drives the no-file fallback. */
  dryRun: boolean;
  /** Default amount used in dry-run when no file/override is present. */
  dryRunDefault: number;
  /** Path to the bankroll file; defaults to `DEFAULT_BANKROLL_PATH`. */
  path?: string;
  /** Live-init source: returns the Polymarket total_value to seed from. */
  fetchPortfolio: () => Promise<Portfolio>;
  /** Clock for `setAt`; injected for tests. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Resolve the active bankroll for this run.
 *
 * Persists the result on every path except dry-run-default. Throws on
 * the live no-file path if the Polymarket portfolio total_value is
 * non-positive, since seeding a bankroll of 0 produces a strategy that
 * can never trade.
 */
export async function resolveBankroll(
  opts: ResolveBankrollOptions,
): Promise<Bankroll> {
  const path = opts.path ?? DEFAULT_BANKROLL_PATH;
  const now = opts.now ?? ((): Date => new Date());

  if (opts.override !== undefined) {
    if (!Number.isFinite(opts.override) || opts.override <= 0) {
      throw new Error(
        `--bankroll must be a positive number, got ${String(opts.override)}`,
      );
    }
    const bankroll: Bankroll = {
      amount: opts.override,
      currency: "USDC",
      source: "user",
      setAt: now().toISOString(),
    };
    saveBankroll(path, bankroll);
    return bankroll;
  }

  const stored = loadBankroll(path);
  if (stored !== null) return stored;

  if (opts.dryRun) {
    return {
      amount: opts.dryRunDefault,
      currency: "USDC",
      source: "default-dry-run",
      setAt: now().toISOString(),
    };
  }

  const portfolio = await opts.fetchPortfolio();
  if (portfolio.total_value <= 0) {
    throw new Error(
      `Cannot initialize bankroll: Polymarket portfolio total_value is`
        + ` $${portfolio.total_value.toFixed(2)}.`
        + ` Fund the wallet (USDC on Polymarket) or pass`
        + ` --bankroll <amount> to override.`,
    );
  }
  const bankroll: Bankroll = {
    amount: portfolio.total_value,
    currency: "USDC",
    source: "balance-init",
    setAt: now().toISOString(),
  };
  saveBankroll(path, bankroll);
  return bankroll;
}
