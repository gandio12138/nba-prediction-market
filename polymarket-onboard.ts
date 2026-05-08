/**
 * Polymarket onboarding adapter — venue-agnostic OnboardClient impl.
 *
 * Wraps `@polymarket/builder-relayer-client` (gasless Safe deploy + batched
 * Safe approvals) and `@polymarket/clob-client-v2` (CLOB API credentials).
 *
 * Spender list and collateral token are read from `getContractConfig(137)` at
 * runtime — never hard-coded — so a Polymarket-side migration (e.g.
 * USDC.e → pUSD) is picked up by upgrading the SDK rather than by editing
 * this file. A malformed config surfaces as an actionable error rather than
 * silently using stale defaults.
 */
// Side-effect: install a browser UA on axios so the SDKs clear CF's bot
// challenge on clob.polymarket.com. Must come before any SDK import that
// builds an axios instance.
import "./clob-axios-defaults.js";
import { Contract, Wallet, providers, utils } from "ethers";
import {
  RelayClient,
  deriveSafe,
} from "@polymarket/builder-relayer-client";
import type { Transaction } from "@polymarket/builder-relayer-client";
// `getContractConfig` lives at `@polymarket/builder-relayer-client/dist/config`
// and the package's `index.d.ts` re-exports it so namespace access typechecks,
// but `dist/index.js` does NOT — so at runtime the symbol is `undefined`. We
// keep the namespace import so vitest's
// `vi.mock("@polymarket/builder-relayer-client")` continues to drive
// `getContractConfig` in tests, and add a static subpath import as the
// runtime fallback used only when the namespace shape is missing it.
import * as builderRelayer from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { getContractConfig as relayerSubpathGetContractConfig } from "@polymarket/builder-relayer-client/dist/config/index.js";
import {
  ClobClient,
  SignatureTypeV2,
  getContractConfig as getClobContractConfig,
} from "@polymarket/clob-client-v2";
import type { Chain } from "@polymarket/clob-client-v2";
import type {
  OnboardClient,
  OnboardStatus,
} from "./types/OnboardClient.js";
import type { MarketVenueOnboard } from "./types/MarketVenueOnboard.js";

const POLYGON_CHAIN_ID = 137;
const RELAYER_URL =
  process.env["POLYMARKET_RELAYER_URL"] ??
  "https://relayer-v2.polymarket.com";
const CLOB_HOST =
  process.env["POLYMARKET_CLOB_HOST"] ?? "https://clob.polymarket.com";
const POLYGON_RPC_URL =
  process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";

// Polygon mainnet addresses for the gasless funding path. These are NOT
// surfaced through `getContractConfig(137)` — Polymarket's SDK only
// returns Safe + CLOB addresses. Each is verified in
// `canon/templates/__tests__/_reference_permit_chain.mjs` (live-run
// 2026-05-03). Don't move them into the SDK config — they're chain
// infrastructure, not Polymarket-controlled.
const USDC_NATIVE_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_E_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const POLYMARKET_ONRAMP = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const UNISWAP_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const UNISWAP_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
// Uniswap V3 USDC↔USDC.e pools exist at three fee tiers; try the
// cheapest first. 0.5% slippage (`9950 / 10_000`) matches the reference
// prototype's tolerance.
const UNISWAP_FEE_TIERS = [100, 500, 3000] as const;
const SLIPPAGE_NUMERATOR = 9950n;
const SLIPPAGE_DENOMINATOR = 10_000n;
const PERMIT_DEADLINE_SECONDS = 3600;
const SWAP_DEADLINE_SECONDS = 600;

const COLLATERAL_DECIMALS = 6;
const MAX_UINT256: bigint = (1n << 256n) - 1n;
// Half of MaxUint256 — anything below this counts as "needs re-approve" so the
// idempotency check is robust against minor allowance burn.
const ALLOWANCE_THRESHOLD: bigint = MAX_UINT256 / 2n;

const APPROVE_SELECTOR = "0x095ea7b3";
const SET_APPROVAL_FOR_ALL_SELECTOR = "0xa22cb465";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
];
const ERC1155_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
];

interface BigNumberLike {
  toBigInt: () => bigint;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as BigNumberLike).toBigInt === "function"
  ) {
    return (value as BigNumberLike).toBigInt();
  }
  throw new TypeError(
    `polymarket-onboard: expected BigNumber-like, got ${typeof value}`,
  );
}

function pad32(hex: string): string {
  return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
}

function encodeApprove(spender: string, amount: bigint): string {
  return APPROVE_SELECTOR + pad32(spender) + pad32(amount.toString(16));
}

function encodeSetApprovalForAll(operator: string, approved: boolean): string {
  return (
    SET_APPROVAL_FOR_ALL_SELECTOR +
    pad32(operator) +
    pad32(approved ? "1" : "0")
  );
}

interface ClobAddresses {
  exchange: string;
  negRiskExchange: string;
  negRiskAdapter: string;
  collateral: string;
  conditionalTokens: string;
  exchangeV2: string;
  negRiskExchangeV2: string;
}

interface ClobConfigShape {
  exchange?: string;
  negRiskExchange?: string;
  negRiskAdapter?: string;
  collateral?: string;
  conditionalTokens?: string;
  exchangeV2?: string;
  negRiskExchangeV2?: string;
}

function loadClobAddresses(): ClobAddresses {
  const cfg = getClobContractConfig(POLYGON_CHAIN_ID) as ClobConfigShape;
  if (!cfg?.exchange) {
    throw new Error(
      "polymarket-onboard: clob getContractConfig() returned an invalid config — missing 'exchange' spender. Refusing to proceed with stale defaults.",
    );
  }
  if (!cfg.negRiskExchange || !cfg.negRiskAdapter) {
    throw new Error(
      "polymarket-onboard: clob getContractConfig() returned an invalid config — missing negRiskExchange/negRiskAdapter spender.",
    );
  }
  if (!cfg.conditionalTokens) {
    throw new Error(
      "polymarket-onboard: clob getContractConfig() returned an invalid config — missing 'conditionalTokens' address.",
    );
  }
  if (!cfg.collateral) {
    throw new Error(
      "polymarket-onboard: clob getContractConfig() returned an invalid config — missing 'collateral' token. Update @polymarket/clob-client-v2 — never hard-code USDC.e vs pUSD.",
    );
  }
  if (!cfg.exchangeV2 || !cfg.negRiskExchangeV2) {
    throw new Error(
      "polymarket-onboard: clob getContractConfig() returned an invalid config — missing V2 spender (exchangeV2/negRiskExchangeV2). V2 markets reject orders without their approvals.",
    );
  }
  return {
    exchange: cfg.exchange,
    negRiskExchange: cfg.negRiskExchange,
    negRiskAdapter: cfg.negRiskAdapter,
    collateral: cfg.collateral,
    conditionalTokens: cfg.conditionalTokens,
    exchangeV2: cfg.exchangeV2,
    negRiskExchangeV2: cfg.negRiskExchangeV2,
  };
}

interface RelayConfigShape {
  SafeContracts?: { SafeFactory?: string; SafeMultisend?: string };
}

function loadSafeFactory(): string {
  const namespaceFn = (
    builderRelayer as unknown as {
      getContractConfig?: (chainId: number) => RelayConfigShape;
    }
  ).getContractConfig;
  // Prefer the namespace export so vi.mock can override it in tests; fall
  // back to the subpath import so live runs work against the unmodified
  // `0.0.9` package whose root entry never re-exports `getContractConfig`.
  const fn: ((chainId: number) => RelayConfigShape) | undefined =
    typeof namespaceFn === "function"
      ? namespaceFn
      : typeof relayerSubpathGetContractConfig === "function"
        ? (relayerSubpathGetContractConfig as unknown as (
            chainId: number,
          ) => RelayConfigShape)
        : undefined;
  if (!fn) {
    throw new Error(
      "polymarket-onboard: @polymarket/builder-relayer-client does not export getContractConfig from the package root or the dist/config subpath — refusing to derive Safe address with no config source.",
    );
  }
  const cfg = fn(POLYGON_CHAIN_ID);
  const safeFactory = cfg?.SafeContracts?.SafeFactory;
  if (!safeFactory) {
    throw new Error(
      "polymarket-onboard: relayer getContractConfig() returned an invalid config — missing 'SafeContracts.SafeFactory'. Refusing to derive Safe address from stale defaults.",
    );
  }
  return safeFactory;
}

interface AllowanceContract {
  allowance(owner: string, spender: string): Promise<unknown>;
  balanceOf(owner: string): Promise<unknown>;
}

interface OperatorContract {
  isApprovedForAll(account: string, operator: string): Promise<boolean>;
}

interface RelayerTxLike {
  hash?: string;
  transactionHash?: string;
  wait: () => Promise<
    { transactionHash?: string; status?: number } | undefined
  >;
}

function erc20SpenderList(addr: ClobAddresses): readonly string[] {
  return [
    addr.exchange,
    addr.negRiskExchange,
    addr.negRiskAdapter,
    addr.conditionalTokens,
    addr.exchangeV2,
    addr.negRiskExchangeV2,
  ];
}

function erc1155OperatorList(addr: ClobAddresses): readonly string[] {
  return [
    addr.exchange,
    addr.negRiskExchange,
    addr.negRiskAdapter,
    addr.exchangeV2,
    addr.negRiskExchangeV2,
  ];
}

interface OnboardCtx {
  safeAddress: string;
  // The ethers v5 provider used for read calls. Typed loosely to avoid
  // pinning the impl to a specific subclass.
  provider: providers.Provider;
  // The EOA's wallet — needed to sign EIP-2612 permits for gasless
  // funding (`ensureFunded`). The relayer-driven mutations
  // (deploy / approvals / wrap) only require the wallet via the
  // `RelayClient` it was constructed with.
  wallet: Wallet;
  relay: RelayClient;
  clob: ClobClient;
}

async function readAllowance(
  ctx: OnboardCtx,
  addr: ClobAddresses,
  spender: string,
): Promise<bigint> {
  const c = new Contract(
    addr.collateral,
    ERC20_ABI,
    ctx.provider,
  ) as unknown as AllowanceContract;
  return asBigInt(await c.allowance(ctx.safeAddress, spender));
}

async function readIsApprovedForAll(
  ctx: OnboardCtx,
  addr: ClobAddresses,
  operator: string,
): Promise<boolean> {
  const c = new Contract(
    addr.conditionalTokens,
    ERC1155_ABI,
    ctx.provider,
  ) as unknown as OperatorContract;
  return c.isApprovedForAll(ctx.safeAddress, operator);
}

async function readCollateralBalance(
  ctx: OnboardCtx,
  addr: ClobAddresses,
): Promise<bigint> {
  const c = new Contract(
    addr.collateral,
    ERC20_ABI,
    ctx.provider,
  ) as unknown as AllowanceContract;
  return asBigInt(await c.balanceOf(ctx.safeAddress));
}

async function statusImpl(ctx: OnboardCtx): Promise<OnboardStatus> {
  const funderDeployed = await ctx.relay.getDeployed(ctx.safeAddress);
  if (!funderDeployed) {
    return {
      funderDeployed: false,
      approvalsReady: false,
      credsReady: false,
      fundedCollateral: 0,
      funderAddress: ctx.safeAddress,
    };
  }
  const addr = loadClobAddresses();
  const erc20Ok = await Promise.all(
    erc20SpenderList(addr).map(
      async (s) => (await readAllowance(ctx, addr, s)) >= ALLOWANCE_THRESHOLD,
    ),
  );
  const erc1155Ok = await Promise.all(
    erc1155OperatorList(addr).map((op) =>
      readIsApprovedForAll(ctx, addr, op),
    ),
  );
  const approvalsReady =
    erc20Ok.every(Boolean) && erc1155Ok.every(Boolean);
  const balance = await readCollateralBalance(ctx, addr);
  const fundedCollateral = Number(balance) / 10 ** COLLATERAL_DECIMALS;
  let credsReady = false;
  try {
    const creds = await ctx.clob.deriveApiKey();
    credsReady = !!(creds?.key && creds.secret && creds.passphrase);
  } catch {
    credsReady = false;
  }
  return {
    funderDeployed: true,
    approvalsReady,
    credsReady,
    fundedCollateral,
    funderAddress: ctx.safeAddress,
  };
}

async function ensureFunderImpl(
  ctx: OnboardCtx,
): Promise<{ deployed: boolean; txHash?: string }> {
  if (await ctx.relay.getDeployed(ctx.safeAddress)) {
    return { deployed: true };
  }
  let tx: RelayerTxLike;
  try {
    tx = (await ctx.relay.deploy()) as unknown as RelayerTxLike;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`polymarket-onboard: relayer deploy() failed — ${msg}`);
  }
  const receipt = await tx.wait();
  const txHash = receipt?.transactionHash ?? tx.transactionHash ?? tx.hash;
  return txHash !== undefined
    ? { deployed: true, txHash }
    : { deployed: true };
}

async function ensureApprovalsImpl(
  ctx: OnboardCtx,
): Promise<{ approved: boolean; txHash?: string }> {
  const addr = loadClobAddresses();
  const txs: Transaction[] = [];
  for (const spender of erc20SpenderList(addr)) {
    if ((await readAllowance(ctx, addr, spender)) < ALLOWANCE_THRESHOLD) {
      txs.push({
        to: addr.collateral,
        data: encodeApprove(spender, MAX_UINT256),
        value: "0",
      });
    }
  }
  for (const operator of erc1155OperatorList(addr)) {
    if (!(await readIsApprovedForAll(ctx, addr, operator))) {
      txs.push({
        to: addr.conditionalTokens,
        data: encodeSetApprovalForAll(operator, true),
        value: "0",
      });
    }
  }
  if (txs.length === 0) {
    return { approved: true };
  }
  const tx = (await ctx.relay.execute(
    txs,
    "canon: initial CLOB approvals",
  )) as unknown as RelayerTxLike;
  const receipt = await tx.wait();
  const txHash = receipt?.transactionHash ?? tx.transactionHash ?? tx.hash;
  return txHash !== undefined
    ? { approved: true, txHash }
    : { approved: true };
}

async function ensureCredsImpl(
  ctx: OnboardCtx,
): Promise<{ key: string; secret: string; passphrase: string }> {
  let creds: { key: string; secret: string; passphrase: string };
  try {
    creds = await ctx.clob.deriveApiKey();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/incomplete/i.test(msg)) {
      throw err;
    }
    creds = await ctx.clob.createApiKey();
  }
  if (!creds?.key || !creds.secret || !creds.passphrase) {
    throw new Error(
      "polymarket-onboard: CLOB returned incomplete creds (missing key/secret/passphrase) after derive+create fallback",
    );
  }
  return creds;
}

// ABIs scoped to ensureFunded — kept inline so the call surface is
// auditable in one place rather than scattered across a constants file.
const PERMIT_ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
];

const ERC20_PERMIT_TRANSFER_APPROVE_ABI = new utils.Interface([
  "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256)",
]);

const SWAP_ROUTER_ABI = new utils.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);

const ONRAMP_ABI = new utils.Interface([
  "function wrap(address,address,uint256)",
]);

const PERMIT_TYPED_DATA_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

interface NonceContract {
  balanceOf(owner: string): Promise<unknown>;
  nonces(owner: string): Promise<unknown>;
}

interface QuoterCallStatic {
  quoteExactInputSingle(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    fee: number;
    sqrtPriceLimitX96: number;
  }): Promise<readonly [bigint, ...unknown[]]>;
}

interface QuoterContract {
  callStatic: QuoterCallStatic;
}

async function quoteSwap(
  ctx: OnboardCtx,
  amount: bigint,
): Promise<{ fee: number; expectedOut: bigint }> {
  const quoter = new Contract(
    UNISWAP_QUOTER_V2,
    QUOTER_ABI,
    ctx.provider,
  ) as unknown as QuoterContract;
  for (const fee of UNISWAP_FEE_TIERS) {
    try {
      const q = await quoter.callStatic.quoteExactInputSingle({
        tokenIn: USDC_NATIVE_POLYGON,
        tokenOut: USDC_E_POLYGON,
        amountIn: amount,
        fee,
        sqrtPriceLimitX96: 0,
      });
      const expectedOut = asBigInt(q[0]);
      if (expectedOut > 0n) return { fee, expectedOut };
    } catch {
      // Pool absent at this fee tier — try the next one. A revert here is
      // not informative; only the absence of any pool is fatal (handled
      // after the loop).
    }
  }
  throw new Error(
    "polymarket-onboard: no Uniswap V3 USDC→USDC.e pool returned a quote at fee tiers 100/500/3000 — refusing to fund without a swap path.",
  );
}

async function buildPermitChainBatch(
  ctx: OnboardCtx,
  amount: bigint,
  nonce: bigint,
  expectedOut: bigint,
  fee: number,
): Promise<Transaction[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const permitDeadline = BigInt(nowSec + PERMIT_DEADLINE_SECONDS);
  const swapDeadline = BigInt(nowSec + SWAP_DEADLINE_SECONDS);
  const minOut =
    (expectedOut * SLIPPAGE_NUMERATOR) / SLIPPAGE_DENOMINATOR;

  const permitDomain = {
    name: "USD Coin",
    version: "2",
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: USDC_NATIVE_POLYGON,
  };
  // ethers v5's Wallet exposes `_signTypedData` (typed-data signer not
  // yet de-underscored at the v5 release we're pinned to).
  const sig = await (
    ctx.wallet as unknown as {
      _signTypedData: (
        domain: typeof permitDomain,
        types: typeof PERMIT_TYPED_DATA_TYPES,
        value: Record<string, unknown>,
      ) => Promise<string>;
    }
  )._signTypedData(permitDomain, PERMIT_TYPED_DATA_TYPES, {
    owner: ctx.wallet.address,
    spender: ctx.safeAddress,
    value: amount,
    nonce,
    deadline: permitDeadline,
  });
  const { r, s, v } = utils.splitSignature(sig);

  return [
    {
      to: USDC_NATIVE_POLYGON,
      value: "0",
      data: ERC20_PERMIT_TRANSFER_APPROVE_ABI.encodeFunctionData("permit", [
        ctx.wallet.address,
        ctx.safeAddress,
        amount,
        permitDeadline,
        v,
        r,
        s,
      ]),
    },
    {
      to: USDC_NATIVE_POLYGON,
      value: "0",
      data: ERC20_PERMIT_TRANSFER_APPROVE_ABI.encodeFunctionData(
        "transferFrom",
        [ctx.wallet.address, ctx.safeAddress, amount],
      ),
    },
    {
      to: USDC_NATIVE_POLYGON,
      value: "0",
      data: ERC20_PERMIT_TRANSFER_APPROVE_ABI.encodeFunctionData("approve", [
        UNISWAP_SWAP_ROUTER,
        MAX_UINT256,
      ]),
    },
    {
      to: UNISWAP_SWAP_ROUTER,
      value: "0",
      data: SWAP_ROUTER_ABI.encodeFunctionData("exactInputSingle", [
        {
          tokenIn: USDC_NATIVE_POLYGON,
          tokenOut: USDC_E_POLYGON,
          fee,
          recipient: ctx.safeAddress,
          deadline: swapDeadline,
          amountIn: amount,
          amountOutMinimum: minOut,
          sqrtPriceLimitX96: 0,
        },
      ]),
    },
    {
      to: USDC_E_POLYGON,
      value: "0",
      data: ERC20_PERMIT_TRANSFER_APPROVE_ABI.encodeFunctionData("approve", [
        POLYMARKET_ONRAMP,
        MAX_UINT256,
      ]),
    },
    {
      to: POLYMARKET_ONRAMP,
      value: "0",
      data: ONRAMP_ABI.encodeFunctionData("wrap", [
        USDC_E_POLYGON,
        ctx.safeAddress,
        minOut,
      ]),
    },
  ];
}

async function ensureFundedImpl(
  ctx: OnboardCtx,
  amountBaseUnits?: bigint,
): Promise<{
  funded: boolean;
  amount: bigint;
  expectedOut: bigint;
  txHash?: string;
}> {
  if (!(await ctx.relay.getDeployed(ctx.safeAddress))) {
    throw new Error(
      "polymarket-onboard: ensureFunded() requires the funder Safe to be deployed first. Call ensureFunder() before ensureFunded().",
    );
  }
  const usdc = new Contract(
    USDC_NATIVE_POLYGON,
    PERMIT_ERC20_ABI,
    ctx.provider,
  ) as unknown as NonceContract;
  const balance = asBigInt(await usdc.balanceOf(ctx.wallet.address));
  if (balance === 0n) {
    return { funded: false, amount: 0n, expectedOut: 0n };
  }
  const amount = amountBaseUnits ?? balance;
  if (amount <= 0n) {
    return { funded: false, amount: 0n, expectedOut: 0n };
  }
  if (amount > balance) {
    throw new Error(
      `polymarket-onboard: requested ensureFunded amount ${amount.toString()} exceeds EOA native USDC balance ${balance.toString()} — refusing to sign a permit that would revert on transferFrom.`,
    );
  }

  const nonce = asBigInt(await usdc.nonces(ctx.wallet.address));
  const { fee, expectedOut } = await quoteSwap(ctx, amount);
  const txs = await buildPermitChainBatch(
    ctx,
    amount,
    nonce,
    expectedOut,
    fee,
  );

  let submission: RelayerTxLike;
  try {
    submission = (await ctx.relay.execute(
      txs,
      "canon: ensureFunded — permit + transferFrom + swap + wrap",
    )) as unknown as RelayerTxLike;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `polymarket-onboard: relayer rejected the permit-chain batch — ${msg}`,
    );
  }
  const receipt = await submission.wait();
  const txHash =
    receipt?.transactionHash ?? submission.transactionHash ?? submission.hash;
  return txHash !== undefined
    ? { funded: true, amount, expectedOut, txHash }
    : { funded: true, amount, expectedOut };
}

function build(privateKey: string): OnboardClient {
  const safeFactory = loadSafeFactory();
  // Pass an explicit network spec to skip the auto-detect round-trip.
  // Default polygon-rpc.com 401s on detection from some IPs; with a
  // pinned network the SDK never calls eth_chainId at construction time.
  const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL, {
    name: "polygon",
    chainId: POLYGON_CHAIN_ID,
  });
  // builder-abstract-signer's EthersSigner constructor calls
  // signer.provider.getNetwork() at instantiation; passing a Wallet
  // without a provider trips "signer is missing provider".
  const wallet = new Wallet(privateKey, provider);
  const safeAddress = deriveSafe(wallet.address, safeFactory);
  const builderConfig = loadBuilderConfig();
  // pnpm hoisting can give us a `BuilderConfig` instance whose private
  // members don't structurally match the one the relayer-client typed
  // its constructor against — the runtime class is identical. Erase the
  // type at the boundary; the actual call is fine.
  const relay = builderConfig
    ? new RelayClient(
        RELAYER_URL,
        POLYGON_CHAIN_ID,
        wallet,
        builderConfig as unknown as ConstructorParameters<typeof RelayClient>[3],
      )
    : new RelayClient(RELAYER_URL, POLYGON_CHAIN_ID, wallet);
  const clob = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID as unknown as Chain,
    signer: wallet,
  });
  const ctx: OnboardCtx = { safeAddress, provider, wallet, relay, clob };
  return {
    status: () => statusImpl(ctx),
    ensureFunder: () => ensureFunderImpl(ctx),
    ensureApprovals: () => ensureApprovalsImpl(ctx),
    ensureCreds: () => ensureCredsImpl(ctx),
    ensureFunded: (amountBaseUnits?: bigint) =>
      ensureFundedImpl(ctx, amountBaseUnits),
  };
}

export const polymarketOnboard: MarketVenueOnboard = {
  venue: "polymarket",
  chainId: POLYGON_CHAIN_ID,
  build,
};

/**
 * Bootstrap Polymarket builder credentials for a fresh wallet.
 *
 * The relayer requires authenticated builder headers on every mutative
 * Safe call (deploy, batched approvals, wraps) — without them every
 * `--execute` is rejected 401. This helper does the two-step dance
 * described in the live-verification handoff:
 *
 *   1. Create a temp ClobClient pinned to the Safe funder
 *      (`signatureType=POLY_GNOSIS_SAFE`, `funderAddress=<safe>`) and
 *      derive trading creds — required to L2-authenticate the next call.
 *   2. Re-init the client with those trading creds attached and call
 *      `createBuilderApiKey()` — returns the persistent builder creds
 *      that `loadBuilderConfig()` reads from env on subsequent runs.
 *
 * Idempotent only at the env layer: callers should check for existing
 * `POLYMARKET_BUILDER_*` env vars before invoking. Calling twice creates
 * a second builder key — Polymarket allows this, but it's wasteful.
 *
 * Throws when either CLOB call returns incomplete creds (missing
 * key/secret/passphrase) so persistence never silently writes a partial
 * record.
 */
export async function bootstrapBuilderCreds(privateKey: string): Promise<{
  key: string;
  secret: string;
  passphrase: string;
}> {
  const safeFactory = loadSafeFactory();
  const provider = new providers.JsonRpcProvider(POLYGON_RPC_URL, {
    name: "polygon",
    chainId: POLYGON_CHAIN_ID,
  });
  const wallet = new Wallet(privateKey, provider);
  const safeAddress = deriveSafe(wallet.address, safeFactory);

  const tempClient = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID as unknown as Chain,
    signer: wallet,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funderAddress: safeAddress,
  });
  const tradingCreds = await tempClient.createOrDeriveApiKey();
  if (
    !tradingCreds?.key ||
    !tradingCreds.secret ||
    !tradingCreds.passphrase
  ) {
    throw new Error(
      "polymarket-onboard: CLOB createOrDeriveApiKey returned incomplete trading creds — cannot bootstrap builder credentials.",
    );
  }

  const authedClient = new ClobClient({
    host: CLOB_HOST,
    chain: POLYGON_CHAIN_ID as unknown as Chain,
    signer: wallet,
    signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
    funderAddress: safeAddress,
    creds: tradingCreds,
  });
  const builderCreds = await authedClient.createBuilderApiKey();
  if (
    !builderCreds?.key ||
    !builderCreds.secret ||
    !builderCreds.passphrase
  ) {
    throw new Error(
      "polymarket-onboard: CLOB createBuilderApiKey returned incomplete builder creds.",
    );
  }
  return {
    key: builderCreds.key,
    secret: builderCreds.secret,
    passphrase: builderCreds.passphrase,
  };
}

/**
 * Load Polymarket builder credentials from env, when present.
 *
 * Polymarket's relayer requires authenticated builder headers on every
 * mutative call (Safe deploy, batched approvals, wraps). Credentials
 * come from the `clob-client-v2` `createBuilderApiKey()` flow or the
 * UI at polymarket.com/settings?tab=builder. Without them the relayer
 * answers 401 — onboarding cannot proceed.
 *
 * Returns `undefined` when any of the three env vars is missing, so
 * read-only paths (e.g. status()) keep working without auth.
 */
function loadBuilderConfig(): BuilderConfig | undefined {
  const key = process.env["POLYMARKET_BUILDER_API_KEY"];
  const secret = process.env["POLYMARKET_BUILDER_SECRET"];
  const passphrase = process.env["POLYMARKET_BUILDER_PASSPHRASE"];
  if (!key || !secret || !passphrase) return undefined;
  return new BuilderConfig({
    localBuilderCreds: { key, secret, passphrase },
  });
}
