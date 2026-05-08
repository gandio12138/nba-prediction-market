import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatBankrollBanner,
  loadBankroll,
  resolveBankroll,
  saveBankroll,
  validateBankroll,
  type Bankroll,
} from "../bankroll.js";
import type { Portfolio } from "../types/RiskInterface.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bankroll-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const FIXED_DATE = new Date("2026-05-04T12:00:00Z");
const fixedNow = (): Date => FIXED_DATE;

function makePortfolio(total: number): Portfolio {
  return { total_value: total, positions: [], daily_pnl: 0 };
}

// ---------------------------------------------------------------------------
// validateBankroll
// ---------------------------------------------------------------------------

describe("validateBankroll", () => {
  it("accepts a well-formed bankroll", () => {
    expect(
      validateBankroll({
        amount: 100,
        currency: "USDC",
        source: "user",
        setAt: "2026-05-04T12:00:00Z",
      }),
    ).toBe(true);
  });

  it("rejects null and non-objects", () => {
    expect(validateBankroll(null)).toBe(false);
    expect(validateBankroll("nope")).toBe(false);
    expect(validateBankroll(42)).toBe(false);
  });

  it("rejects non-positive or non-finite amounts", () => {
    const base = {
      currency: "USDC",
      source: "user" as const,
      setAt: "2026-05-04T12:00:00Z",
    };
    expect(validateBankroll({ ...base, amount: 0 })).toBe(false);
    expect(validateBankroll({ ...base, amount: -10 })).toBe(false);
    expect(validateBankroll({ ...base, amount: Number.NaN })).toBe(false);
    expect(validateBankroll({ ...base, amount: Number.POSITIVE_INFINITY }))
      .toBe(false);
  });

  it("rejects unknown source values and non-USDC currency", () => {
    expect(
      validateBankroll({
        amount: 1,
        currency: "USDC",
        source: "unknown",
        setAt: "2026-05-04T12:00:00Z",
      }),
    ).toBe(false);
    expect(
      validateBankroll({
        amount: 1,
        currency: "DAI",
        source: "user",
        setAt: "2026-05-04T12:00:00Z",
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// load + save round-trip
// ---------------------------------------------------------------------------

describe("loadBankroll + saveBankroll", () => {
  it("returns null when file does not exist", () => {
    expect(loadBankroll(join(tmp, "missing.json"))).toBeNull();
  });

  it("round-trips a valid bankroll", () => {
    const path = join(tmp, "nested", "bankroll.json");
    const bankroll: Bankroll = {
      amount: 9.83,
      currency: "USDC",
      source: "balance-init",
      setAt: "2026-05-04T12:00:00Z",
    };
    saveBankroll(path, bankroll);
    expect(loadBankroll(path)).toStrictEqual(bankroll);
  });

  it("returns null for malformed JSON", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, "{ not: json");
    expect(loadBankroll(path)).toBeNull();
  });

  it("returns null for valid JSON failing schema", () => {
    const path = join(tmp, "wrong-shape.json");
    writeFileSync(path, JSON.stringify({ amount: -5, currency: "USDC" }));
    expect(loadBankroll(path)).toBeNull();
  });

  it("writes atomically (no .tmp left behind)", () => {
    const path = join(tmp, "atomic.json");
    saveBankroll(path, {
      amount: 100,
      currency: "USDC",
      source: "user",
      setAt: "2026-05-04T12:00:00Z",
    });
    expect(readFileSync(path, "utf-8")).toContain('"amount": 100');
    expect(loadBankroll(`${path}.tmp`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveBankroll
// ---------------------------------------------------------------------------

describe("resolveBankroll", () => {
  it("uses --bankroll override and persists with source=user", async () => {
    const path = join(tmp, "bankroll.json");
    const fetchPortfolio = vi.fn();
    const result = await resolveBankroll({
      override: 250,
      dryRun: true,
      dryRunDefault: 10_000,
      path,
      fetchPortfolio,
      now: fixedNow,
    });
    expect(result.amount).toBe(250);
    expect(result.source).toBe("user");
    expect(result.setAt).toBe(FIXED_DATE.toISOString());
    expect(fetchPortfolio).not.toHaveBeenCalled();
    expect(loadBankroll(path)).toStrictEqual(result);
  });

  it("rejects non-positive or non-finite overrides", async () => {
    const path = join(tmp, "bankroll.json");
    const fetchPortfolio = vi.fn();
    await expect(
      resolveBankroll({
        override: 0,
        dryRun: true,
        dryRunDefault: 10_000,
        path,
        fetchPortfolio,
      }),
    ).rejects.toThrow(/positive number/);
    await expect(
      resolveBankroll({
        override: Number.NaN,
        dryRun: true,
        dryRunDefault: 10_000,
        path,
        fetchPortfolio,
      }),
    ).rejects.toThrow(/positive number/);
  });

  it("returns the stored bankroll without fetching when file exists", async () => {
    const path = join(tmp, "bankroll.json");
    const stored: Bankroll = {
      amount: 9.83,
      currency: "USDC",
      source: "balance-init",
      setAt: "2026-04-30T08:00:00Z",
    };
    saveBankroll(path, stored);
    const fetchPortfolio = vi.fn();
    const result = await resolveBankroll({
      dryRun: false,
      dryRunDefault: 10_000,
      path,
      fetchPortfolio,
      now: fixedNow,
    });
    expect(result).toStrictEqual(stored);
    expect(fetchPortfolio).not.toHaveBeenCalled();
  });

  it("falls back to dry-run default without persisting", async () => {
    const path = join(tmp, "bankroll.json");
    const fetchPortfolio = vi.fn();
    const result = await resolveBankroll({
      dryRun: true,
      dryRunDefault: 10_000,
      path,
      fetchPortfolio,
      now: fixedNow,
    });
    expect(result.amount).toBe(10_000);
    expect(result.source).toBe("default-dry-run");
    expect(loadBankroll(path)).toBeNull();
    expect(fetchPortfolio).not.toHaveBeenCalled();
  });

  it("initializes from Polymarket portfolio on first live run and persists", async () => {
    const path = join(tmp, "bankroll.json");
    const fetchPortfolio = vi.fn().mockResolvedValue(makePortfolio(9.83));
    const result = await resolveBankroll({
      dryRun: false,
      dryRunDefault: 10_000,
      path,
      fetchPortfolio,
      now: fixedNow,
    });
    expect(result.amount).toBe(9.83);
    expect(result.source).toBe("balance-init");
    expect(result.setAt).toBe(FIXED_DATE.toISOString());
    expect(loadBankroll(path)).toStrictEqual(result);
  });

  it("throws when live first-run portfolio total_value is zero", async () => {
    const path = join(tmp, "bankroll.json");
    const fetchPortfolio = vi.fn().mockResolvedValue(makePortfolio(0));
    await expect(
      resolveBankroll({
        dryRun: false,
        dryRunDefault: 10_000,
        path,
        fetchPortfolio,
      }),
    ).rejects.toThrow(/total_value is \$0\.00/);
    expect(loadBankroll(path)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatBankrollBanner
// ---------------------------------------------------------------------------

describe("formatBankrollBanner", () => {
  it("formats user-set banner", () => {
    const banner = formatBankrollBanner({
      amount: 250,
      currency: "USDC",
      source: "user",
      setAt: "2026-05-04T12:00:00Z",
    });
    expect(banner).toBe("BANKROLL=$250.00 (set by --bankroll on 2026-05-04)");
  });

  it("formats balance-init banner with override hint", () => {
    const banner = formatBankrollBanner({
      amount: 9.83,
      currency: "USDC",
      source: "balance-init",
      setAt: "2026-05-04T12:00:00Z",
    });
    expect(banner).toContain("$9.83");
    expect(banner).toContain("Polymarket balance");
    expect(banner).toContain("--bankroll");
    expect(banner).toContain("2026-05-04");
  });

  it("formats dry-run-default banner", () => {
    const banner = formatBankrollBanner({
      amount: 10_000,
      currency: "USDC",
      source: "default-dry-run",
      setAt: "2026-05-04T12:00:00Z",
    });
    expect(banner).toBe("BANKROLL=$10000.00 (dry-run default)");
  });
});
