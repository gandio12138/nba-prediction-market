/**
 * Tests for the USDC allowance adapter (`canon/templates/usdc-allowance.ts`).
 *
 * Defines the contract for `createUsdcAllowanceClient()`:
 *   - `getAllowance()` reads ERC-20 `allowance(owner, spender)` via the
 *     injected provider and returns a raw 6-decimal `bigint`.
 *   - `approve(amount)` submits an `approve(spender, amount)` transaction
 *     via the injected signer, waits for one confirmation, and returns
 *     `{ txHash }`.
 *   - Errors from the RPC / transaction surface to the caller; no
 *     swallowed exceptions.
 *
 * The adapter currently delegates the on-chain calls to ethers v5
 * (`new Contract(...)`). These tests mock the `ethers` module so no
 * network is required. They are written ahead of the real
 * implementation (item 2 of the plan) and will fail against the
 * stubbed `AllowanceNotImplementedError` in the current source.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  USDC_E_ADDRESS,
  CTF_EXCHANGE_ADDRESS,
  DEFAULT_ALLOWANCE_SPENDER,
  POLYGON_CHAIN_ID,
} from "../polygon-addresses.js";
import type {
  UsdcAllowanceConfig,
  createUsdcAllowanceClient as CreateUsdcAllowanceClientFn,
} from "../usdc-allowance.js";

// ---------------------------------------------------------------------------
// ethers v5 Contract mock
// ---------------------------------------------------------------------------

const mockAllowance = vi.fn();
const mockApprove = vi.fn();

// Regular function (not arrow) so `new ContractCtor(...)` is valid.
// ethers v5 `Contract` is a class — the adapter calls it with `new`.
const ContractCtor = vi.fn(function ContractStub(
  this: { allowance: unknown; approve: unknown },
  _address: string,
  _abi: unknown,
  _runner: unknown,
) {
  this.allowance = mockAllowance;
  this.approve = mockApprove;
});

vi.mock("ethers", () => ({
  // ethers v5 exposes both the namespace and the named export
  ethers: { Contract: ContractCtor },
  Contract: ContractCtor,
}));

let createUsdcAllowanceClient: typeof CreateUsdcAllowanceClientFn;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../usdc-allowance.js");
  createUsdcAllowanceClient = mod.createUsdcAllowanceClient;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";

function makeConfig(
  overrides: Partial<UsdcAllowanceConfig> = {},
): UsdcAllowanceConfig {
  const provider = { _isProvider: true };
  const signer = { _isSigner: true };
  return {
    ownerAddress: OWNER,
    spenderAddress: DEFAULT_ALLOWANCE_SPENDER,
    usdcAddress: USDC_E_ADDRESS,
    getProvider: vi.fn(async () => provider),
    getSigner: vi.fn(async () => signer),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Address constants (polygon-addresses.ts)
// ---------------------------------------------------------------------------

describe("polygon-addresses constants", () => {
  it("pins the bridged USDC.e contract on Polygon", () => {
    expect(USDC_E_ADDRESS).toBe(
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    );
  });

  it("pins the Polymarket CTF Exchange address", () => {
    expect(CTF_EXCHANGE_ADDRESS).toBe(
      "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    );
  });

  it("defaults the allowance spender to the standard CTF Exchange (ARB-01 binary markets)", () => {
    expect(DEFAULT_ALLOWANCE_SPENDER).toBe(CTF_EXCHANGE_ADDRESS);
  });

  it("uses Polygon mainnet chain id", () => {
    expect(POLYGON_CHAIN_ID).toBe(137);
  });
});

// ---------------------------------------------------------------------------
// getAllowance
// ---------------------------------------------------------------------------

describe("createUsdcAllowanceClient.getAllowance", () => {
  it("reads ERC-20 allowance(owner, spender) via the injected provider and returns a bigint", async () => {
    // ethers v5 returns a BigNumber; the adapter must convert.
    mockAllowance.mockResolvedValueOnce({
      toBigInt: () => 123_456_000_000n,
    });

    const config = makeConfig();
    const client = createUsdcAllowanceClient(config);
    const result = await client.getAllowance();

    expect(result).toBe(123_456_000_000n);
    expect(config.getProvider).toHaveBeenCalled();
    expect(mockAllowance).toHaveBeenCalledWith(OWNER, DEFAULT_ALLOWANCE_SPENDER);
  });

  it("constructs the ERC-20 contract against the configured USDC address", async () => {
    mockAllowance.mockResolvedValueOnce({ toBigInt: () => 0n });

    const client = createUsdcAllowanceClient(makeConfig());
    await client.getAllowance();

    const firstCallArgs = ContractCtor.mock.calls[0];
    expect(firstCallArgs?.[0]).toBe(USDC_E_ADDRESS);
  });

  it("accepts a plain bigint return (skips toBigInt for native bigints)", async () => {
    mockAllowance.mockResolvedValueOnce(42n);

    const client = createUsdcAllowanceClient(makeConfig());
    const result = await client.getAllowance();

    expect(result).toBe(42n);
  });

  it("propagates RPC errors", async () => {
    mockAllowance.mockRejectedValueOnce(new Error("RPC unreachable"));

    const client = createUsdcAllowanceClient(makeConfig());

    await expect(client.getAllowance()).rejects.toThrow(/rpc unreachable/i);
  });
});

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

describe("createUsdcAllowanceClient.approve", () => {
  it("submits approve(spender, amount) via the signer and returns the tx hash after one confirmation", async () => {
    const wait = vi.fn().mockResolvedValueOnce({ status: 1 });
    mockApprove.mockResolvedValueOnce({ hash: "0xdeadbeef", wait });

    const config = makeConfig();
    const client = createUsdcAllowanceClient(config);
    const result = await client.approve(1_000_000_000_000n);

    expect(config.getSigner).toHaveBeenCalled();
    expect(mockApprove).toHaveBeenCalledWith(
      DEFAULT_ALLOWANCE_SPENDER,
      1_000_000_000_000n,
    );
    expect(wait).toHaveBeenCalledOnce();
    expect(result).toEqual({ txHash: "0xdeadbeef" });
  });

  it("forwards the exact bigint amount without rounding or scaling", async () => {
    const wait = vi.fn().mockResolvedValueOnce({ status: 1 });
    mockApprove.mockResolvedValueOnce({ hash: "0xabc", wait });

    const client = createUsdcAllowanceClient(makeConfig());
    await client.approve(7n);

    expect(mockApprove).toHaveBeenCalledWith(DEFAULT_ALLOWANCE_SPENDER, 7n);
  });

  it("propagates errors raised while submitting the transaction", async () => {
    mockApprove.mockRejectedValueOnce(new Error("user rejected"));

    const client = createUsdcAllowanceClient(makeConfig());

    await expect(client.approve(1n)).rejects.toThrow(/user rejected/i);
  });

  it("propagates errors raised while waiting for confirmation", async () => {
    const wait = vi.fn().mockRejectedValueOnce(new Error("tx reverted"));
    mockApprove.mockResolvedValueOnce({ hash: "0xfailed", wait });

    const client = createUsdcAllowanceClient(makeConfig());

    await expect(client.approve(1n)).rejects.toThrow(/tx reverted/i);
  });
});
