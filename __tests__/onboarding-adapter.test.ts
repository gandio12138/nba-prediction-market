/**
 * Adapter contract test — pins the `MarketVenueOnboard` interface so any
 * future adapter (Kalshi, ...) is held to the same idempotency and
 * state-transition guarantees as the Polymarket adapter.
 *
 * The contract is expressed as a generic suite parameterised by:
 *   - the `MarketVenueOnboard` under test
 *   - a `AdapterHarness` that can flip the underlying mocks between
 *     "fresh EOA", "deployed", "approvals ready", "creds derivable", etc.
 *
 * Today the suite runs against `polymarketOnboard` only. Adding Kalshi
 * means writing a Kalshi harness and adding one more
 * `runAdapterContract(...)` call below — no edits to the contract itself.
 *
 * The mocks below mirror `__tests__/onboarding.test.ts`. They are kept
 * standalone (rather than imported from that file) because `vi.mock`
 * factories are hoisted per-file and cannot be re-used across test files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MarketVenueOnboard } from "../types/MarketVenueOnboard.ts";

// ---------------------------------------------------------------------------
// @polymarket/builder-relayer-client mocks
// ---------------------------------------------------------------------------

const mockRelayDeploy = vi.fn();
const mockRelayGetDeployed = vi.fn();
const mockRelayExecute = vi.fn();
const mockDeriveSafe = vi.fn();
const mockRelayerContractConfig = vi.fn();

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
const mockClobContractConfig = vi.fn();

const ClobClientCtor = vi.fn(function ClobClientStub(
  this: { deriveApiKey: unknown; createApiKey: unknown },
  _opts: unknown,
) {
  this.deriveApiKey = mockDeriveApiKey;
  this.createApiKey = mockCreateApiKey;
});

vi.mock("@polymarket/clob-client-v2", () => ({
  ClobClient: ClobClientCtor,
  SignatureTypeV2: { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2 },
  getContractConfig: mockClobContractConfig,
}));

// ---------------------------------------------------------------------------
// ethers v5 mocks (on-chain reads + Wallet for signing)
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

const EOA = "0x1111111111111111111111111111111111111111";

const mockSignTypedData = vi.fn();

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
// Constants
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

// ---------------------------------------------------------------------------
// Generic harness — every adapter must provide one of these for its tests.
// ---------------------------------------------------------------------------

/**
 * Lets the contract suite simulate state changes against an adapter's
 * underlying integrations. A harness owns its venue-specific mocks; the
 * suite only sees the abstract operations below.
 */
interface AdapterHarness {
  /** Reset to "fresh EOA" — no funder, no approvals, no creds. */
  resetToFreshEoa(): void;
  /** Simulate the funder being deployed on-chain. */
  markFunderDeployed(): void;
  /** Simulate every required spender having full allowance. */
  markApprovalsReady(): void;
  /** Simulate at least one spender missing approval. */
  markApprovalsMissing(): void;
  /** Simulate creds being derivable from the signer. */
  markCredsDerivable(): void;
  /**
   * Simulate `derive` returning "incomplete" so the adapter falls back to
   * `create`. The caller is asserting a derive→create transition — both
   * legs must complete with full creds.
   */
  markCredsNeedCreation(): void;
}

// ---------------------------------------------------------------------------
// Polymarket harness implementation
// ---------------------------------------------------------------------------

function createPolymarketHarness(): AdapterHarness {
  function configureRelayerConfig(): void {
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
  }

  function configureClobConfig(): void {
    mockClobContractConfig.mockReturnValue({
      exchange: EXCHANGE,
      negRiskAdapter: NEG_RISK_ADAPTER,
      negRiskExchange: NEG_RISK_EXCHANGE,
      collateral: COLLATERAL,
      conditionalTokens: CTF,
      exchangeV2: EXCHANGE,
      negRiskExchangeV2: NEG_RISK_EXCHANGE,
    });
  }

  return {
    resetToFreshEoa(): void {
      configureRelayerConfig();
      configureClobConfig();
      mockDeriveSafe.mockReturnValue(SAFE);

      // Funder not deployed — status() short-circuits.
      mockRelayGetDeployed.mockResolvedValue(false);
      // If anything reads beyond the short-circuit, default to "missing".
      mockAllowance.mockResolvedValue(bigNumberLike(0n));
      mockIsApprovedForAll.mockResolvedValue(false);
      mockBalanceOf.mockResolvedValue(bigNumberLike(0n));
      mockDeriveApiKey.mockRejectedValue(new Error("incomplete"));
      mockCreateApiKey.mockResolvedValue(NEW_CREDS);

      // Stub deploy/execute with valid receipts so transitions complete.
      mockRelayDeploy.mockResolvedValue(txReceiptLike("0xdeploy"));
      mockRelayExecute.mockResolvedValue(txReceiptLike("0xapprove"));
    },
    markFunderDeployed(): void {
      mockRelayGetDeployed.mockResolvedValue(true);
    },
    markApprovalsReady(): void {
      mockAllowance.mockResolvedValue(bigNumberLike(MAX_UINT256));
      mockIsApprovedForAll.mockResolvedValue(true);
    },
    markApprovalsMissing(): void {
      mockAllowance.mockResolvedValue(bigNumberLike(0n));
      mockIsApprovedForAll.mockResolvedValue(false);
    },
    markCredsDerivable(): void {
      mockDeriveApiKey.mockResolvedValue(FULL_CREDS);
    },
    markCredsNeedCreation(): void {
      mockDeriveApiKey.mockRejectedValue(new Error("incomplete creds"));
      mockCreateApiKey.mockResolvedValue(NEW_CREDS);
    },
  };
}

// ---------------------------------------------------------------------------
// Generic contract suite — runs against any adapter + harness pair.
// ---------------------------------------------------------------------------

interface ContractFixture {
  adapter: MarketVenueOnboard;
  harness: AdapterHarness;
  privateKey: string;
}

function runAdapterContract(
  name: string,
  load: () => Promise<ContractFixture>,
): void {
  describe(`MarketVenueOnboard contract — ${name}`, () => {
    let fixture: ContractFixture;

    beforeEach(async () => {
      vi.clearAllMocks();
      vi.resetModules();
      fixture = await load();
      fixture.harness.resetToFreshEoa();
    });

    describe("registry hook", () => {
      it("declares a non-empty venue id and a positive chainId", () => {
        expect(typeof fixture.adapter.venue).toBe("string");
        expect(fixture.adapter.venue.length).toBeGreaterThan(0);
        expect(typeof fixture.adapter.chainId).toBe("number");
        expect(fixture.adapter.chainId).toBeGreaterThan(0);
      });

      it("build(privateKey) returns an OnboardClient with the five methods", () => {
        const client = fixture.adapter.build(fixture.privateKey);
        expect(typeof client.status).toBe("function");
        expect(typeof client.ensureFunder).toBe("function");
        expect(typeof client.ensureApprovals).toBe("function");
        expect(typeof client.ensureCreds).toBe("function");
        expect(typeof client.ensureFunded).toBe("function");
      });
    });

    describe("ensureFunder() idempotency", () => {
      it("is a no-op when the funder is already deployed", async () => {
        fixture.harness.markFunderDeployed();
        const client = fixture.adapter.build(fixture.privateKey);

        const first = await client.ensureFunder();
        expect(first.deployed).toBe(true);
        expect(first.txHash).toBeUndefined();
      });

      it("settles to deployed=true after a fresh deploy and stays a no-op on the second call", async () => {
        const client = fixture.adapter.build(fixture.privateKey);

        // First call: not deployed → adapter must deploy.
        const first = await client.ensureFunder();
        expect(first.deployed).toBe(true);

        // Simulate the relayer reflecting the deploy.
        fixture.harness.markFunderDeployed();

        // Second call: already deployed → no new tx.
        const second = await client.ensureFunder();
        expect(second.deployed).toBe(true);
        expect(second.txHash).toBeUndefined();
      });
    });

    describe("ensureApprovals() idempotency", () => {
      it("is a no-op when every spender is already approved", async () => {
        fixture.harness.markFunderDeployed();
        fixture.harness.markApprovalsReady();
        const client = fixture.adapter.build(fixture.privateKey);

        const result = await client.ensureApprovals();
        expect(result.approved).toBe(true);
        expect(result.txHash).toBeUndefined();
      });

      it("submits one batch on the first call and skips on the second", async () => {
        fixture.harness.markFunderDeployed();
        fixture.harness.markApprovalsMissing();
        const client = fixture.adapter.build(fixture.privateKey);

        const first = await client.ensureApprovals();
        expect(first.approved).toBe(true);

        // Simulate the on-chain state catching up.
        fixture.harness.markApprovalsReady();

        const second = await client.ensureApprovals();
        expect(second.approved).toBe(true);
        expect(second.txHash).toBeUndefined();
      });
    });

    describe("ensureCreds() idempotency", () => {
      it("returns full creds when derive succeeds and is stable across calls", async () => {
        fixture.harness.markCredsDerivable();
        const client = fixture.adapter.build(fixture.privateKey);

        const first = await client.ensureCreds();
        expect(first.key).toBeTruthy();
        expect(first.secret).toBeTruthy();
        expect(first.passphrase).toBeTruthy();

        const second = await client.ensureCreds();
        expect(second.key).toBe(first.key);
        expect(second.secret).toBe(first.secret);
        expect(second.passphrase).toBe(first.passphrase);
      });

      it("falls back to create on the first call, then derive on the second", async () => {
        fixture.harness.markCredsNeedCreation();
        const client = fixture.adapter.build(fixture.privateKey);

        const first = await client.ensureCreds();
        expect(first.key).toBeTruthy();
        expect(first.secret).toBeTruthy();
        expect(first.passphrase).toBeTruthy();

        // After create, derive should succeed.
        fixture.harness.markCredsDerivable();
        const second = await client.ensureCreds();
        expect(second.key).toBeTruthy();
        expect(second.secret).toBeTruthy();
        expect(second.passphrase).toBeTruthy();
      });
    });

    describe("status() reflects state transitions", () => {
      it("starts unboarded and reports a stable funderAddress", async () => {
        const client = fixture.adapter.build(fixture.privateKey);
        const initial = await client.status();

        expect(initial.funderDeployed).toBe(false);
        expect(initial.approvalsReady).toBe(false);
        expect(initial.credsReady).toBe(false);
        expect(initial.fundedCollateral).toBe(0);
        expect(typeof initial.funderAddress).toBe("string");
        expect(initial.funderAddress.length).toBeGreaterThan(0);

        // funderAddress must not change as state evolves.
        fixture.harness.markFunderDeployed();
        const next = await client.status();
        expect(next.funderAddress).toBe(initial.funderAddress);
      });

      it("flips funderDeployed once the funder exists", async () => {
        const client = fixture.adapter.build(fixture.privateKey);
        expect((await client.status()).funderDeployed).toBe(false);

        fixture.harness.markFunderDeployed();
        expect((await client.status()).funderDeployed).toBe(true);
      });

      it("flips approvalsReady once every spender is approved", async () => {
        const client = fixture.adapter.build(fixture.privateKey);

        fixture.harness.markFunderDeployed();
        fixture.harness.markApprovalsMissing();
        expect((await client.status()).approvalsReady).toBe(false);

        fixture.harness.markApprovalsReady();
        expect((await client.status()).approvalsReady).toBe(true);
      });

      it("flips credsReady once derive returns full creds", async () => {
        const client = fixture.adapter.build(fixture.privateKey);

        fixture.harness.markFunderDeployed();
        fixture.harness.markApprovalsReady();
        fixture.harness.markCredsNeedCreation(); // derive throws
        expect((await client.status()).credsReady).toBe(false);

        fixture.harness.markCredsDerivable();
        expect((await client.status()).credsReady).toBe(true);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Apply the contract to polymarketOnboard.
// ---------------------------------------------------------------------------

runAdapterContract("polymarketOnboard", async () => {
  const mod = await import("../polymarket-onboard.js");
  return {
    adapter: mod.polymarketOnboard,
    harness: createPolymarketHarness(),
    privateKey: PRIVATE_KEY,
  };
});
