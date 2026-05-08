/**
 * Tests for the CTF mint adapter (`canon/templates/ctf-mint.ts`).
 *
 * The adapter wraps Gnosis `ConditionalTokens.splitPosition(...)` —
 * MINT-01 uses it to convert USDC.e collateral into a paired YES + NO
 * holding, then sells both legs at midpoint + 0.75¢.
 *
 * These tests pin the contract by mocking ethers v5 `Contract` — no
 * RPC, no wallet. They cover the happy path (correct argument shape,
 * tx hash returned after one confirmation), input validation
 * (positive amount, partition length), and error propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { USDC_E_ADDRESS } from "../polygon-addresses.js";
import type {
  CtfMintConfig,
  createCtfMintClient as CreateCtfMintClientFn,
} from "../ctf-mint.js";

// ---------------------------------------------------------------------------
// ethers v5 Contract mock
// ---------------------------------------------------------------------------

const mockSplitPosition = vi.fn();

const ContractCtor = vi.fn(function ContractStub(
  this: { splitPosition: unknown },
  _address: string,
  _abi: unknown,
  _runner: unknown,
) {
  this.splitPosition = mockSplitPosition;
});

vi.mock("ethers", () => ({
  ethers: { Contract: ContractCtor },
  Contract: ContractCtor,
}));

let createCtfMintClient: typeof CreateCtfMintClientFn;
let BINARY_PARTITION: readonly [bigint, bigint];
let ROOT_PARENT_COLLECTION_ID: string;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  const mod = await import("../ctf-mint.js");
  createCtfMintClient = mod.createCtfMintClient;
  BINARY_PARTITION = mod.BINARY_PARTITION;
  ROOT_PARENT_COLLECTION_ID = mod.ROOT_PARENT_COLLECTION_ID;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONDITIONAL_TOKENS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const CONDITION_ID =
  "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function makeConfig(overrides: Partial<CtfMintConfig> = {}): CtfMintConfig {
  const provider = { _isProvider: true };
  const signer = { _isSigner: true };
  return {
    conditionalTokensAddress: CONDITIONAL_TOKENS,
    collateralAddress: USDC_E_ADDRESS,
    getProvider: vi.fn(async () => provider),
    getSigner: vi.fn(async () => signer),
    ...overrides,
  };
}

function stubSplitOk(hash = "0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface") {
  const wait = vi.fn().mockResolvedValueOnce({ status: 1 });
  mockSplitPosition.mockResolvedValueOnce({ hash, wait });
  return { hash, wait };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

describe("ctf-mint module exports", () => {
  it("exposes the binary YES/NO partition as [1n, 2n]", () => {
    expect(BINARY_PARTITION).toEqual([1n, 2n]);
  });

  it("exposes a 32-byte zero parent collection id", () => {
    expect(ROOT_PARENT_COLLECTION_ID).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });
});

// ---------------------------------------------------------------------------
// splitPosition — happy path
// ---------------------------------------------------------------------------

describe("createCtfMintClient.splitPosition", () => {
  it("calls splitPosition(collateral, root, conditionId, [1,2], amount) via the signer and returns the tx hash", async () => {
    const { hash, wait } = stubSplitOk();
    const config = makeConfig();
    const client = createCtfMintClient(config);

    const result = await client.splitPosition({
      conditionId: CONDITION_ID,
      amount: 1_000_000_000n, // $1,000 in 6-decimal USDC.e
    });

    expect(config.getSigner).toHaveBeenCalled();
    expect(mockSplitPosition).toHaveBeenCalledWith(
      USDC_E_ADDRESS,
      ROOT_PARENT_COLLECTION_ID,
      CONDITION_ID,
      [1n, 2n],
      1_000_000_000n,
    );
    expect(wait).toHaveBeenCalledOnce();
    expect(result).toEqual({ txHash: hash });
  });

  it("constructs the contract against the configured ConditionalTokens address", async () => {
    stubSplitOk();
    const client = createCtfMintClient(makeConfig());
    await client.splitPosition({
      conditionId: CONDITION_ID,
      amount: 1n,
    });

    const firstCallArgs = ContractCtor.mock.calls[0];
    expect(firstCallArgs?.[0]).toBe(CONDITIONAL_TOKENS);
  });

  it("forwards the bigint amount without rounding or scaling", async () => {
    stubSplitOk();
    const client = createCtfMintClient(makeConfig());
    await client.splitPosition({
      conditionId: CONDITION_ID,
      amount: 7n,
    });

    const args = mockSplitPosition.mock.calls[0];
    expect(args?.[4]).toBe(7n);
  });

  it("accepts an explicit parentCollectionId override", async () => {
    stubSplitOk();
    const parent =
      "0x1111111111111111111111111111111111111111111111111111111111111111";
    const client = createCtfMintClient(makeConfig());
    await client.splitPosition({
      conditionId: CONDITION_ID,
      amount: 1n,
      parentCollectionId: parent,
    });

    const args = mockSplitPosition.mock.calls[0];
    expect(args?.[1]).toBe(parent);
  });

  it("accepts an explicit partition override", async () => {
    stubSplitOk();
    const client = createCtfMintClient(makeConfig());
    await client.splitPosition({
      conditionId: CONDITION_ID,
      amount: 1n,
      partition: [1n, 2n, 4n],
    });

    const args = mockSplitPosition.mock.calls[0];
    expect(args?.[3]).toEqual([1n, 2n, 4n]);
  });
});

// ---------------------------------------------------------------------------
// splitPosition — input validation
// ---------------------------------------------------------------------------

describe("createCtfMintClient.splitPosition input validation", () => {
  it("rejects a zero amount", async () => {
    const client = createCtfMintClient(makeConfig());
    await expect(
      client.splitPosition({ conditionId: CONDITION_ID, amount: 0n }),
    ).rejects.toThrow(/amount must be > 0/i);
    expect(mockSplitPosition).not.toHaveBeenCalled();
  });

  it("rejects a negative amount", async () => {
    const client = createCtfMintClient(makeConfig());
    await expect(
      client.splitPosition({ conditionId: CONDITION_ID, amount: -1n }),
    ).rejects.toThrow(/amount must be > 0/i);
    expect(mockSplitPosition).not.toHaveBeenCalled();
  });

  it("rejects a partition with fewer than 2 entries", async () => {
    const client = createCtfMintClient(makeConfig());
    await expect(
      client.splitPosition({
        conditionId: CONDITION_ID,
        amount: 1n,
        partition: [1n],
      }),
    ).rejects.toThrow(/partition/i);
    expect(mockSplitPosition).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// splitPosition — error propagation
// ---------------------------------------------------------------------------

describe("createCtfMintClient.splitPosition error propagation", () => {
  it("propagates errors raised while submitting the transaction", async () => {
    mockSplitPosition.mockRejectedValueOnce(new Error("user rejected"));
    const client = createCtfMintClient(makeConfig());

    await expect(
      client.splitPosition({ conditionId: CONDITION_ID, amount: 1n }),
    ).rejects.toThrow(/user rejected/i);
  });

  it("propagates errors raised while waiting for confirmation", async () => {
    const wait = vi.fn().mockRejectedValueOnce(new Error("tx reverted"));
    mockSplitPosition.mockResolvedValueOnce({ hash: "0xfailed", wait });
    const client = createCtfMintClient(makeConfig());

    await expect(
      client.splitPosition({ conditionId: CONDITION_ID, amount: 1n }),
    ).rejects.toThrow(/tx reverted/i);
  });
});
