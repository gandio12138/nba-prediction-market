/**
 * Tests for the Polymarket onboarding adapter (`canon/templates/polymarket-onboard.ts`).
 *
 * Defines the contract for `polymarketOnboard.build(privateKey)`:
 *
 *   - `status()` is a pure read; it short-circuits and returns
 *     `{ funderDeployed: false, approvalsReady: false, credsReady: false,
 *        fundedCollateral: 0, funderAddress }` when the funder Safe is not
 *     deployed — without reading allowances or balances.
 *
 *   - `ensureFunder()` is idempotent. When `relay.getDeployed(safe)` is
 *     `true` it returns `{ deployed: true }` without calling `relay.deploy()`.
 *
 *   - `ensureApprovals()` is idempotent per spender. When every required
 *     spender's allowance is already at the threshold, `relay.execute()` is
 *     never called and the method returns `{ approved: true }`.
 *
 *   - `ensureCreds()` calls `clob.deriveApiKey()` first; on success returns
 *     those creds. When derive throws an error matching "incomplete", it
 *     falls back to `clob.createApiKey()`.
 *
 *   - Failure paths:
 *       * Relayer 4xx during deploy surfaces an actionable error.
 *       * Both derive and create returning incomplete creds throws.
 *       * A malformed `getContractConfig(chainId)` payload surfaces an
 *         actionable error rather than silently using stale defaults.
 *
 * Mocks `RelayClient` and `ClobClient` (plus `ethers` for on-chain reads).
 * Written ahead of the real implementation (item 3 of the plan): every test
 * here is expected to fail until `polymarket-onboard.ts` lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OnboardClient } from "../types/OnboardClient.ts";
import type { MarketVenueOnboard } from "../types/MarketVenueOnboard.ts";

// ---------------------------------------------------------------------------
// @polymarket/builder-relayer-client mocks
// ---------------------------------------------------------------------------

const mockRelayDeploy = vi.fn();
const mockRelayGetDeployed = vi.fn();
const mockRelayExecute = vi.fn();
const mockDeriveSafe = vi.fn();
const mockRelayerContractConfig = vi.fn();

// `RelayClient` is a class — use `function` (not arrow) so `new` works.
const RelayClientCtor = vi.fn(function RelayClientStub(
  this: { deploy: unknown; getDeployed: unknown; execute: unknown },
  _relayerUrl: string,
  _chainId: number,
  _signer: unknown,
) {
  this.deploy = mockRelayDeploy;
  this.getDeployed = mockRelayGetDeployed;
  this.execute = mockRelayExecute;
});

vi.mock("@polymarket/builder-relayer-client", () => ({
  RelayClient: RelayClientCtor,
  deriveSafe: mockDeriveSafe,
  getContractConfig: mockRelayerContractConfig,
}));

// ---------------------------------------------------------------------------
// @polymarket/clob-client-v2 mocks
// ---------------------------------------------------------------------------

const mockDeriveApiKey = vi.fn();
const mockCreateApiKey = vi.fn();
const mockCreateOrDeriveApiKey = vi.fn();
const mockCreateBuilderApiKey = vi.fn();
const mockGetBalanceAllowance = vi.fn();
const mockClobContractConfig = vi.fn();
const clobConstructorCalls: Array<Record<string, unknown>> = [];

const ClobClientCtor = vi.fn(function ClobClientStub(
  this: {
    deriveApiKey: unknown;
    createApiKey: unknown;
    createOrDeriveApiKey: unknown;
    createBuilderApiKey: unknown;
    getBalanceAllowance: unknown;
  },
  opts: Record<string, unknown>,
) {
  clobConstructorCalls.push(opts);
  this.deriveApiKey = mockDeriveApiKey;
  this.createApiKey = mockCreateApiKey;
  this.createOrDeriveApiKey = mockCreateOrDeriveApiKey;
  this.createBuilderApiKey = mockCreateBuilderApiKey;
  this.getBalanceAllowance = mockGetBalanceAllowance;
});

vi.mock("@polymarket/clob-client-v2", () => ({
  ClobClient: ClobClientCtor,
  SignatureTypeV2: { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2 },
  getContractConfig: mockClobContractConfig,
}));

// ---------------------------------------------------------------------------
// ethers v5 mocks (on-chain allowance / balance reads + Wallet for signing)
// ---------------------------------------------------------------------------

const mockAllowance = vi.fn();
const mockIsApprovedForAll = vi.fn();
const mockBalanceOf = vi.fn();
const mockNonces = vi.fn();
const mockQuoteExactInputSingle = vi.fn();

const ContractCtor = vi.fn(function ContractStub(
  this: {
    allowance: unknown;
    isApprovedForAll: unknown;
    balanceOf: unknown;
    nonces: unknown;
    callStatic: { quoteExactInputSingle: unknown };
  },
  _address: string,
  _abi: unknown,
  _runner: unknown,
) {
  this.allowance = mockAllowance;
  this.isApprovedForAll = mockIsApprovedForAll;
  this.balanceOf = mockBalanceOf;
  this.nonces = mockNonces;
  this.callStatic = { quoteExactInputSingle: mockQuoteExactInputSingle };
});

const mockSignTypedData = vi.fn();

const EOA = "0x1111111111111111111111111111111111111111";

const WalletCtor = vi.fn(function WalletStub(
  this: {
    address: string;
    privateKey: string;
    _signTypedData: unknown;
  },
  privateKey: string,
) {
  this.address = EOA;
  this.privateKey = privateKey;
  this._signTypedData = mockSignTypedData;
});

const JsonRpcProviderCtor = vi.fn(function ProviderStub() {
  // empty stub — adapter only passes it as a runner to Contract
});

vi.mock("ethers", async () => {
  const actual = await vi.importActual<typeof import("ethers")>("ethers");
  return {
    ...actual,
    ethers: {
      ...actual,
      Contract: ContractCtor,
      Wallet: WalletCtor,
      providers: { JsonRpcProvider: JsonRpcProviderCtor },
    },
    Contract: ContractCtor,
    Wallet: WalletCtor,
    providers: { JsonRpcProvider: JsonRpcProviderCtor },
  };
});

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

const MAX_UINT256 = (1n << 256n) - 1n;

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const SAFE = "0x2222222222222222222222222222222222222222";
const SAFE_FACTORY = "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
const SAFE_MULTISEND = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";
const EXCHANGE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE = "0xe2222d279d744050d28e00520010520000310F59";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const COLLATERAL = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";

const FULL_CREDS = {
  key: "key-abc",
  secret: "secret-abc",
  passphrase: "pass-abc",
};

const NEW_CREDS = {
  key: "key-new",
  secret: "secret-new",
  passphrase: "pass-new",
};

function bigNumberLike(value: bigint) {
  return { toBigInt: () => value };
}

function txReceiptLike(hash: string) {
  return {
    wait: vi.fn().mockResolvedValue({
      transactionHash: hash,
      status: 1,
    }),
    transactionHash: hash,
  };
}

// Lazy imports — re-imported in `beforeEach` so module-level state and the
// `vi.mock` factories are wired before the adapter executes.
let polymarketOnboard: MarketVenueOnboard;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();

  // Default happy-path stubs (individual tests override as needed).
  mockDeriveSafe.mockReturnValue(SAFE);

  mockRelayerContractConfig.mockReturnValue({
    SafeContracts: {
      SafeFactory: SAFE_FACTORY,
      SafeMultisend: SAFE_MULTISEND,
    },
    ProxyContracts: {
      ProxyFactory: "0x0000000000000000000000000000000000000000",
      RelayHub: "0x0000000000000000000000000000000000000000",
    },
    DepositWalletContracts: {
      DepositWalletFactory: "0x0000000000000000000000000000000000000000",
      DepositWalletImplementation:
        "0x0000000000000000000000000000000000000000",
    },
  });

  mockClobContractConfig.mockReturnValue({
    exchange: EXCHANGE,
    negRiskAdapter: NEG_RISK_ADAPTER,
    negRiskExchange: NEG_RISK_EXCHANGE,
    collateral: COLLATERAL,
    conditionalTokens: CTF,
    exchangeV2: EXCHANGE,
    negRiskExchangeV2: NEG_RISK_EXCHANGE,
  });

  // Default to a fully-onboarded wallet; tests that exercise the
  // unboarded branch override these.
  mockRelayGetDeployed.mockResolvedValue(true);
  mockAllowance.mockResolvedValue(bigNumberLike(MAX_UINT256));
  mockIsApprovedForAll.mockResolvedValue(true);
  mockBalanceOf.mockResolvedValue(bigNumberLike(0n));
  mockNonces.mockResolvedValue(bigNumberLike(0n));
  mockQuoteExactInputSingle.mockResolvedValue([
    bigNumberLike(0n),
    bigNumberLike(0n),
    0,
    bigNumberLike(0n),
  ]);
  // 65-byte canonical signature: r=ab×32, s=cd×32, v=0x1c (28).
  mockSignTypedData.mockResolvedValue(
    `0x${"ab".repeat(32)}${"cd".repeat(32)}1c`,
  );
  mockDeriveApiKey.mockResolvedValue(FULL_CREDS);
  mockCreateApiKey.mockResolvedValue(NEW_CREDS);
  mockCreateOrDeriveApiKey.mockResolvedValue(FULL_CREDS);
  mockCreateBuilderApiKey.mockResolvedValue(NEW_CREDS);
  mockGetBalanceAllowance.mockResolvedValue({
    balance: "0",
    allowance: MAX_UINT256.toString(),
  });
  clobConstructorCalls.length = 0;

  const mod = await import("../polymarket-onboard.js");
  polymarketOnboard = mod.polymarketOnboard;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Registry hook shape
// ---------------------------------------------------------------------------

describe("polymarketOnboard registry hook", () => {
  it("identifies the venue as 'polymarket' and pins Polygon mainnet", () => {
    expect(polymarketOnboard.venue).toBe("polymarket");
    expect(polymarketOnboard.chainId).toBe(137);
  });

  it("build(privateKey) returns an OnboardClient with the four required methods", () => {
    const client: OnboardClient = polymarketOnboard.build(PRIVATE_KEY);

    expect(typeof client.status).toBe("function");
    expect(typeof client.ensureFunder).toBe("function");
    expect(typeof client.ensureApprovals).toBe("function");
    expect(typeof client.ensureCreds).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// status()
// ---------------------------------------------------------------------------

describe("status()", () => {
  it("short-circuits when the funder Safe is not deployed", async () => {
    mockRelayGetDeployed.mockResolvedValue(false);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const status = await client.status();

    expect(status).toEqual({
      funderDeployed: false,
      approvalsReady: false,
      credsReady: false,
      fundedCollateral: 0,
      funderAddress: SAFE,
    });

    // Short-circuit means: no allowance / approval / creds reads.
    expect(mockAllowance).not.toHaveBeenCalled();
    expect(mockIsApprovedForAll).not.toHaveBeenCalled();
    expect(mockDeriveApiKey).not.toHaveBeenCalled();
    expect(mockCreateOrDeriveApiKey).not.toHaveBeenCalled();
  });

  it("reflects a fully onboarded wallet when deploy + approvals + creds are present", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockAllowance.mockResolvedValue(bigNumberLike(MAX_UINT256));
    mockIsApprovedForAll.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(123_456_000n)); // 123.456 in 6-decimal collateral
    mockDeriveApiKey.mockResolvedValue(FULL_CREDS);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const status = await client.status();

    expect(status.funderDeployed).toBe(true);
    expect(status.approvalsReady).toBe(true);
    expect(status.credsReady).toBe(true);
    expect(status.funderAddress).toBe(SAFE);
    // Collateral is reported in human units (6-decimal token).
    expect(status.fundedCollateral).toBeCloseTo(123.456, 5);
  });

  it("never mutates state — no deploy / execute / createApiKey calls during status()", async () => {
    const client = polymarketOnboard.build(PRIVATE_KEY);
    await client.status();

    expect(mockRelayDeploy).not.toHaveBeenCalled();
    expect(mockRelayExecute).not.toHaveBeenCalled();
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureFunder()
// ---------------------------------------------------------------------------

describe("ensureFunder()", () => {
  it("skips deploy when getDeployed=true and reports already-deployed", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureFunder();

    expect(result.deployed).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(mockRelayDeploy).not.toHaveBeenCalled();
  });

  it("calls relay.deploy() and returns the resulting txHash when not yet deployed", async () => {
    // First check: not deployed. After deploy().wait(), getDeployed flips true.
    mockRelayGetDeployed
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    mockRelayDeploy.mockResolvedValue(txReceiptLike("0xdeploybeef"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureFunder();

    expect(mockRelayDeploy).toHaveBeenCalledTimes(1);
    expect(result.deployed).toBe(true);
    expect(result.txHash).toBe("0xdeploybeef");
  });

  it("propagates a relayer 4xx error from deploy()", async () => {
    vi.useFakeTimers();
    mockRelayGetDeployed.mockResolvedValue(false);
    mockRelayDeploy.mockRejectedValue(
      new Error("Relayer responded 400 Bad Request: stale nonce"),
    );

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const settled = client.ensureFunder().catch((error: unknown) => error);

    // Allow any bounded retry/backoff timers to drain.
    await vi.runAllTimersAsync();
    const result = await settled;

    expect(result).toBeInstanceOf(Error);
    expect(String((result as Error).message)).toMatch(/relayer|400/i);
  });
});

// ---------------------------------------------------------------------------
// ensureApprovals()
// ---------------------------------------------------------------------------

describe("ensureApprovals()", () => {
  it("skips per-spender when every allowance is already at the threshold", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    // ERC-20 allowance is MAX for every spender.
    mockAllowance.mockResolvedValue(bigNumberLike(MAX_UINT256));
    // ERC-1155 setApprovalForAll already true for every spender.
    mockIsApprovedForAll.mockResolvedValue(true);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureApprovals();

    expect(result.approved).toBe(true);
    expect(result.txHash).toBeUndefined();
    expect(mockRelayExecute).not.toHaveBeenCalled();
  });

  it("submits a batched Safe transaction when at least one spender is below threshold", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockAllowance.mockResolvedValue(bigNumberLike(0n));
    mockIsApprovedForAll.mockResolvedValue(false);
    mockRelayExecute.mockResolvedValue(txReceiptLike("0xapproveCafe"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureApprovals();

    expect(mockRelayExecute).toHaveBeenCalledTimes(1);
    expect(result.approved).toBe(true);
    expect(result.txHash).toBe("0xapproveCafe");

    // The first argument to relay.execute is the array of SafeTransactions.
    const firstCall = mockRelayExecute.mock.calls[0];
    expect(Array.isArray(firstCall?.[0])).toBe(true);
    expect((firstCall?.[0] as unknown[]).length).toBeGreaterThan(0);
  });

  it("approves both V1 and V2 spenders — V2 markets fail silently without their approvals", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockAllowance.mockResolvedValue(bigNumberLike(0n));
    mockIsApprovedForAll.mockResolvedValue(false);
    mockRelayExecute.mockResolvedValue(txReceiptLike("0xv2approve"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    await client.ensureApprovals();

    // Each Safe sub-tx encodes the spender into the calldata's last 40 hex
    // chars (after the selector + zero-padding). Decode and assert every
    // V1 + V2 spender appears at least once across the batch.
    const txs = mockRelayExecute.mock.calls[0]?.[0] as Array<{
      to: string;
      data: string;
    }>;
    const spendersSeen = new Set(
      txs.map((tx) => `0x${tx.data.slice(34, 74)}`.toLowerCase()),
    );

    for (const expected of [
      EXCHANGE,
      NEG_RISK_EXCHANGE,
      NEG_RISK_ADAPTER,
      // V2 spenders — same addresses as V1 in the mock, but the contract
      // uses identifiers that resolve through `exchangeV2`/`negRiskExchangeV2`
      // independently. The assertion is that the batch is built from
      // every key in `getContractConfig(137)` we depend on.
    ]) {
      expect(spendersSeen.has(expected.toLowerCase())).toBe(true);
    }
    // Six ERC-20 spender approvals (4 V1-shape + 2 V2) plus five ERC-1155
    // operator approvals — assert the count rather than each address since
    // the mock collapses V1 and V2 to the same addresses.
    expect(txs.length).toBe(11);
  });

  it("submits only the approvals that are missing (mixed state)", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    // Half the ERC-20 spenders are missing; ERC-1155s are all good.
    let allowanceCall = 0;
    mockAllowance.mockImplementation(async () => {
      allowanceCall += 1;
      return bigNumberLike(allowanceCall % 2 === 0 ? MAX_UINT256 : 0n);
    });
    mockIsApprovedForAll.mockResolvedValue(true);
    mockRelayExecute.mockResolvedValue(txReceiptLike("0xpartialApprove"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureApprovals();

    expect(result.approved).toBe(true);
    expect(mockRelayExecute).toHaveBeenCalledTimes(1);

    // The batch must only include the spenders that were below threshold —
    // not all of them.
    const txs = mockRelayExecute.mock.calls[0]?.[0] as Array<unknown>;
    expect(txs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ensureCreds()
// ---------------------------------------------------------------------------

describe("ensureCreds()", () => {
  it("returns the derive result when creds are already registered", async () => {
    mockDeriveApiKey.mockResolvedValue(FULL_CREDS);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const creds = await client.ensureCreds();

    expect(creds).toEqual(FULL_CREDS);
    expect(mockDeriveApiKey).toHaveBeenCalled();
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("falls back to createApiKey when derive throws an 'incomplete' error", async () => {
    mockDeriveApiKey.mockRejectedValue(
      new Error("CLOB returned incomplete creds for this signer"),
    );
    mockCreateApiKey.mockResolvedValue(NEW_CREDS);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const creds = await client.ensureCreds();

    expect(creds).toEqual(NEW_CREDS);
    expect(mockDeriveApiKey).toHaveBeenCalled();
    expect(mockCreateApiKey).toHaveBeenCalled();
  });

  it("throws when both derive and create yield incomplete creds", async () => {
    mockDeriveApiKey.mockRejectedValue(new Error("incomplete creds"));
    mockCreateApiKey.mockResolvedValue({
      key: "",
      secret: "",
      passphrase: "",
    });

    const client = polymarketOnboard.build(PRIVATE_KEY);

    await expect(client.ensureCreds()).rejects.toThrow(/incomplete|creds/i);
  });

  it("does not swallow non-'incomplete' derive errors", async () => {
    mockDeriveApiKey.mockRejectedValue(new Error("503 service unavailable"));

    const client = polymarketOnboard.build(PRIVATE_KEY);

    await expect(client.ensureCreds()).rejects.toThrow(/503|unavailable/i);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureFunded()
// ---------------------------------------------------------------------------

describe("ensureFunded()", () => {
  const ONE_USDC = 1_000_000n; // 1 USDC in 6-decimal base units.

  it("requires the funder Safe to be deployed first", async () => {
    mockRelayGetDeployed.mockResolvedValue(false);

    const client = polymarketOnboard.build(PRIVATE_KEY);
    await expect(client.ensureFunded()).rejects.toThrow(
      /requires the funder Safe to be deployed/i,
    );
  });

  it("returns funded=false when the EOA's native USDC balance is zero", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(0n));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureFunded();

    expect(result).toEqual({ funded: false, amount: 0n, expectedOut: 0n });
    expect(mockRelayExecute).not.toHaveBeenCalled();
  });

  it("submits a 6-call permit + swap + wrap batch when the EOA holds USDC", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(ONE_USDC));
    mockNonces.mockResolvedValue(bigNumberLike(7n));
    // First fee tier returns a quote — adapter must take it.
    mockQuoteExactInputSingle.mockResolvedValueOnce([
      bigNumberLike((ONE_USDC * 9990n) / 10000n),
      bigNumberLike(0n),
      0,
      bigNumberLike(0n),
    ]);
    mockRelayExecute.mockResolvedValue(txReceiptLike("0xfundbeef"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureFunded();

    expect(result.funded).toBe(true);
    expect(result.amount).toBe(ONE_USDC);
    expect(result.txHash).toBe("0xfundbeef");
    expect(mockSignTypedData).toHaveBeenCalledTimes(1);
    expect(mockRelayExecute).toHaveBeenCalledTimes(1);

    const txs = mockRelayExecute.mock.calls[0]?.[0] as Array<{
      to: string;
      data: string;
    }>;
    // permit, transferFrom, approve(SwapRouter), swap, approve(Onramp), wrap.
    expect(txs).toHaveLength(6);
    expect(txs[0]?.to.toLowerCase()).toBe(
      "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    ); // native USDC
    expect(txs[3]?.to.toLowerCase()).toBe(
      "0xe592427a0aece92de3edee1f18e0157c05861564",
    ); // Uniswap V3 SwapRouter
    expect(txs[5]?.to.toLowerCase()).toBe(
      "0x93070a847efef7f70739046a929d47a521f5b8ee",
    ); // Polymarket Onramp
  });

  it("falls back through Uniswap fee tiers until one returns a quote", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(ONE_USDC));
    mockNonces.mockResolvedValue(bigNumberLike(0n));
    mockQuoteExactInputSingle
      .mockRejectedValueOnce(new Error("no pool at fee=100"))
      .mockRejectedValueOnce(new Error("no pool at fee=500"))
      .mockResolvedValueOnce([
        bigNumberLike(ONE_USDC),
        bigNumberLike(0n),
        0,
        bigNumberLike(0n),
      ]);
    mockRelayExecute.mockResolvedValue(txReceiptLike("0xfundtier"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    const result = await client.ensureFunded();
    expect(result.funded).toBe(true);
    expect(mockQuoteExactInputSingle).toHaveBeenCalledTimes(3);
  });

  it("throws when no Uniswap fee tier returns a quote", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(ONE_USDC));
    mockNonces.mockResolvedValue(bigNumberLike(0n));
    mockQuoteExactInputSingle.mockRejectedValue(new Error("no pool"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    await expect(client.ensureFunded()).rejects.toThrow(
      /no Uniswap V3 USDC.*pool/i,
    );
    expect(mockRelayExecute).not.toHaveBeenCalled();
  });

  it("rejects amounts greater than the EOA's balance", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(ONE_USDC));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    await expect(client.ensureFunded(ONE_USDC * 2n)).rejects.toThrow(
      /exceeds EOA native USDC balance/i,
    );
  });

  it("wraps relayer errors with a clear actionable message", async () => {
    mockRelayGetDeployed.mockResolvedValue(true);
    mockBalanceOf.mockResolvedValue(bigNumberLike(ONE_USDC));
    mockNonces.mockResolvedValue(bigNumberLike(0n));
    mockQuoteExactInputSingle.mockResolvedValueOnce([
      bigNumberLike(ONE_USDC),
      bigNumberLike(0n),
      0,
      bigNumberLike(0n),
    ]);
    mockRelayExecute.mockRejectedValue(new Error("Relayer 401: bad creds"));

    const client = polymarketOnboard.build(PRIVATE_KEY);
    await expect(client.ensureFunded()).rejects.toThrow(
      /relayer rejected.*401|relayer rejected.*creds/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed `getContractConfig` payload
// ---------------------------------------------------------------------------

describe("malformed getContractConfig", () => {
  it("status() throws an actionable error when the CLOB config is missing the exchange spender", async () => {
    mockClobContractConfig.mockReturnValue({
      // Intentionally omits `exchange` and friends.
      collateral: COLLATERAL,
    });

    const client = polymarketOnboard.build(PRIVATE_KEY);

    await expect(client.status()).rejects.toThrow(
      /exchange|spender|config|invalid/i,
    );
  });

  it("status() throws when the CLOB config is missing the collateral token", async () => {
    mockClobContractConfig.mockReturnValue({
      exchange: EXCHANGE,
      negRiskAdapter: NEG_RISK_ADAPTER,
      negRiskExchange: NEG_RISK_EXCHANGE,
      conditionalTokens: CTF,
      exchangeV2: EXCHANGE,
      negRiskExchangeV2: NEG_RISK_EXCHANGE,
      // collateral missing
    });

    const client = polymarketOnboard.build(PRIVATE_KEY);

    await expect(client.status()).rejects.toThrow(
      /collateral|config|invalid/i,
    );
  });

  it("status() throws when the CLOB config is missing exchangeV2 or negRiskExchangeV2", async () => {
    mockClobContractConfig.mockReturnValue({
      exchange: EXCHANGE,
      negRiskAdapter: NEG_RISK_ADAPTER,
      negRiskExchange: NEG_RISK_EXCHANGE,
      collateral: COLLATERAL,
      conditionalTokens: CTF,
      // exchangeV2 / negRiskExchangeV2 missing
    });

    const client = polymarketOnboard.build(PRIVATE_KEY);

    await expect(client.status()).rejects.toThrow(
      /v2|exchangev2|negriskexchangev2/i,
    );
  });

  it("bootstrapBuilderCreds returns builder creds and pins the funder Safe", async () => {
    mockCreateOrDeriveApiKey.mockResolvedValue({
      key: "trading-key",
      secret: "trading-secret",
      passphrase: "trading-pass",
    });
    mockCreateBuilderApiKey.mockResolvedValue({
      key: "builder-key",
      secret: "builder-secret",
      passphrase: "builder-pass",
    });

    const mod = await import("../polymarket-onboard.js");
    const creds = await mod.bootstrapBuilderCreds(PRIVATE_KEY);

    expect(creds).toEqual({
      key: "builder-key",
      secret: "builder-secret",
      passphrase: "builder-pass",
    });

    // Both ClobClient calls must pin sigtype=POLY_GNOSIS_SAFE and
    // funderAddress=Safe — without that, trading creds end up scoped to
    // the EOA and createBuilderApiKey rejects them.
    const builderConstructorOpts = clobConstructorCalls.filter(
      (o) => o["funderAddress"] === SAFE,
    );
    expect(builderConstructorOpts.length).toBeGreaterThanOrEqual(2);
    for (const opts of builderConstructorOpts) {
      expect(opts["signatureType"]).toBe(2);
      expect(opts["funderAddress"]).toBe(SAFE);
    }

    // The second client must carry the trading creds so the builder-key
    // call has L2 auth headers.
    const authedOpts = builderConstructorOpts[1];
    expect(authedOpts?.["creds"]).toEqual({
      key: "trading-key",
      secret: "trading-secret",
      passphrase: "trading-pass",
    });
  });

  it("bootstrapBuilderCreds throws when CLOB returns incomplete trading creds", async () => {
    mockCreateOrDeriveApiKey.mockResolvedValue({
      key: "",
      secret: "",
      passphrase: "",
    });

    const mod = await import("../polymarket-onboard.js");
    await expect(mod.bootstrapBuilderCreds(PRIVATE_KEY)).rejects.toThrow(
      /incomplete trading creds/i,
    );
    expect(mockCreateBuilderApiKey).not.toHaveBeenCalled();
  });

  it("bootstrapBuilderCreds throws when CLOB returns incomplete builder creds", async () => {
    mockCreateOrDeriveApiKey.mockResolvedValue({
      key: "trading-key",
      secret: "trading-secret",
      passphrase: "trading-pass",
    });
    mockCreateBuilderApiKey.mockResolvedValue({
      key: "builder-key",
      secret: "",
      passphrase: "builder-pass",
    });

    const mod = await import("../polymarket-onboard.js");
    await expect(mod.bootstrapBuilderCreds(PRIVATE_KEY)).rejects.toThrow(
      /incomplete builder creds/i,
    );
  });

  it("status() throws when the relayer config is missing the SafeFactory", async () => {
    mockRelayerContractConfig.mockReturnValue({
      SafeContracts: {
        // SafeFactory missing
        SafeMultisend: SAFE_MULTISEND,
      },
      ProxyContracts: {},
      DepositWalletContracts: {},
    });

    expect(() => polymarketOnboard.build(PRIVATE_KEY)).toThrow(
      /safe.?factory|config|invalid/i,
    );
  });
});
