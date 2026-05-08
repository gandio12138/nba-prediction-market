import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// ethers mock — no live RPC. Set up before importing the module under test.
// ---------------------------------------------------------------------------

const mockGetBalance = vi.fn();
const mockBalanceOf = vi.fn();
const mockAllowance = vi.fn();
const mockApprove = vi.fn();
const mockQuoteExactInputSingle = vi.fn();
const mockExactInputSingle = vi.fn();
const mockGetBlock = vi.fn();

class MockBigNumber {
  constructor(public value: bigint) {}
  lt(other: MockBigNumber): boolean {
    return this.value < other.value;
  }
  mul(n: number | bigint): MockBigNumber {
    return new MockBigNumber(this.value * BigInt(n));
  }
  div(n: number | bigint): MockBigNumber {
    return new MockBigNumber(this.value / BigInt(n));
  }
  add(other: MockBigNumber): MockBigNumber {
    return new MockBigNumber(this.value + other.value);
  }
  toString(): string {
    return this.value.toString();
  }
}

class MockContract {
  constructor(public address: string, public abi: readonly string[]) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
  callStatic = {
    quoteExactInputSingle: mockQuoteExactInputSingle,
  };
  balanceOf = mockBalanceOf;
  allowance = mockAllowance;
  approve = mockApprove;
  exactInputSingle = mockExactInputSingle;
}

class MockWallet {
  address = "0xWALLET";
  constructor(public privateKey: string, public _provider?: unknown) {}
}

class MockProvider {
  constructor(public url: string, public network: unknown) {}
  getBalance = mockGetBalance;
  getBlock = mockGetBlock;
}

vi.mock("ethers", () => {
  const ethers = {
    providers: {
      StaticJsonRpcProvider: MockProvider,
    },
    Wallet: MockWallet,
    Contract: MockContract,
    constants: {
      MaxUint256: new MockBigNumber(2n ** 256n - 1n),
    },
    utils: {
      parseUnits: (v: string, decimals: number | string): MockBigNumber => {
        const d = typeof decimals === "number" ? decimals : Number(decimals);
        const factor = 10n ** BigInt(d);
        const [whole = "0", frac = ""] = v.split(".");
        const fracPadded = (frac + "0".repeat(d)).slice(0, d);
        return new MockBigNumber(BigInt(whole) * factor + BigInt(fracPadded || "0"));
      },
      formatUnits: (v: { toString(): string }, decimals: number | string): string => {
        const d = typeof decimals === "number" ? decimals : Number(decimals);
        const raw = BigInt(v.toString());
        const factor = 10n ** BigInt(d);
        const whole = raw / factor;
        const frac = raw % factor;
        return `${whole.toString()}.${frac.toString().padStart(d, "0")}`;
      },
    },
  };
  return { ethers, default: ethers };
});

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

let mod: typeof import("../../adapters/polymarket-onchain.js");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env["POLYMARKET_PRIVATE_KEY"] = "0x" + "1".repeat(64);
  delete process.env["SWAP_SLIPPAGE_BPS"];
  delete process.env["POLYGON_RPC_URL"];
  mod = await import("../../adapters/polymarket-onchain.js");
});

afterEach(() => {
  delete process.env["POLYMARKET_PRIVATE_KEY"];
  delete process.env["SWAP_SLIPPAGE_BPS"];
});

// ---------------------------------------------------------------------------
// SWAP_ROUTES config shape
// ---------------------------------------------------------------------------

describe("SWAP_ROUTES", () => {
  it("exports a route entry for USDC, USDT, and POL", () => {
    expect(Object.keys(mod.SWAP_ROUTES).sort()).toEqual(["POL", "USDC", "USDT"]);
  });

  it.each(["USDC", "USDT", "POL"] as const)(
    "%s route has tokenIn, decimals, feeCandidates, isNative",
    (key) => {
      const route = mod.SWAP_ROUTES[key];
      expect(typeof route.tokenIn).toBe("string");
      expect(route.tokenIn).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(typeof route.decimals).toBe("number");
      expect(route.decimals).toBeGreaterThan(0);
      expect(Array.isArray(route.feeCandidates)).toBe(true);
      expect(route.feeCandidates.length).toBeGreaterThan(0);
      for (const fee of route.feeCandidates) {
        expect(typeof fee).toBe("number");
        expect(fee).toBeGreaterThan(0);
      }
      expect(typeof route.isNative).toBe("boolean");
    },
  );

  it("USDC and USDT routes use 6 decimals; POL uses 18", () => {
    expect(mod.SWAP_ROUTES.USDC.decimals).toBe(6);
    expect(mod.SWAP_ROUTES.USDT.decimals).toBe(6);
    expect(mod.SWAP_ROUTES.POL.decimals).toBe(18);
  });

  it("only POL is marked isNative", () => {
    expect(mod.SWAP_ROUTES.USDC.isNative).toBe(false);
    expect(mod.SWAP_ROUTES.USDT.isNative).toBe(false);
    expect(mod.SWAP_ROUTES.POL.isNative).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// swapToUsdce input validation
// ---------------------------------------------------------------------------

describe("swapToUsdce input validation", () => {
  it("rejects amountIn <= 0", async () => {
    await expect(mod.swapToUsdce("USDC", 0)).rejects.toThrow(/amountIn/);
    await expect(mod.swapToUsdce("USDC", -1)).rejects.toThrow(/amountIn/);
  });

  it("requires POLYMARKET_PRIVATE_KEY", async () => {
    delete process.env["POLYMARKET_PRIVATE_KEY"];
    await expect(mod.swapToUsdce("USDC", 1)).rejects.toThrow(
      /POLYMARKET_PRIVATE_KEY/,
    );
  });

  it("rejects out-of-range SWAP_SLIPPAGE_BPS", async () => {
    process.env["SWAP_SLIPPAGE_BPS"] = "5000";
    await expect(mod.swapToUsdce("USDC", 1)).rejects.toThrow(
      /SWAP_SLIPPAGE_BPS/,
    );
  });

  it("rejects non-numeric SWAP_SLIPPAGE_BPS", async () => {
    process.env["SWAP_SLIPPAGE_BPS"] = "abc";
    await expect(mod.swapToUsdce("USDC", 1)).rejects.toThrow(
      /SWAP_SLIPPAGE_BPS/,
    );
  });

  it("rejects negative SWAP_SLIPPAGE_BPS", async () => {
    process.env["SWAP_SLIPPAGE_BPS"] = "-10";
    await expect(mod.swapToUsdce("USDC", 1)).rejects.toThrow(
      /SWAP_SLIPPAGE_BPS/,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchOnChainBalances input validation
// ---------------------------------------------------------------------------

describe("fetchOnChainBalances", () => {
  it("requires POLYMARKET_PRIVATE_KEY", async () => {
    delete process.env["POLYMARKET_PRIVATE_KEY"];
    await expect(mod.fetchOnChainBalances()).rejects.toThrow(
      /POLYMARKET_PRIVATE_KEY/,
    );
  });
});
