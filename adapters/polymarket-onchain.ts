/**
 * Polygon-only on-chain helpers for the Polymarket adapter.
 *
 * These helpers are not part of the venue-agnostic `MarketClient`
 * interface — they encode Polygon/USDC.e specifics (Uniswap v3 routing,
 * native USDC vs USDC.e distinction) that have no analogue on other
 * prediction-market venues.
 */

/** On-chain balance entry with product metadata for the user. */
export interface OnChainBalance {
  /** Display symbol (e.g. "USDC.e", "USDC", "POL"). */
  currency: string;
  /** Token contract address, or "native" for POL. */
  address: string;
  /** Human-readable balance (decimal-adjusted). */
  amount: number;
  /** True if this token can be used directly on Polymarket. */
  tradeable: boolean;
  /** Optional hint for the user about what to do with this balance. */
  note?: string;
}

/** Assets swap-to-usdce supports on Polygon. */
export type SwapSource = "USDC" | "USDT" | "POL";

/** Result of a swap-to-USDC.e on-chain transaction. */
export interface SwapResult {
  from: SwapSource;
  amountIn: number;
  amountOut: number;
  txHash: string;
  approveTxHash?: string;
}

/** Uniswap v3 swap route description for a supported source asset. */
export interface SwapRoute {
  tokenIn: string;
  decimals: number;
  /** Fee tiers to try in order — first one with a quote wins. */
  feeCandidates: readonly number[];
  isNative: boolean;
}

const SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNISWAP_QUOTER_V2 = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";
const USDC_E_ADDR = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WPOL_ADDR = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

export const SWAP_ROUTES: Record<SwapSource, SwapRoute> = {
  USDC: {
    tokenIn: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    decimals: 6,
    feeCandidates: [100, 500],
    isNative: false,
  },
  USDT: {
    tokenIn: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6,
    feeCandidates: [100, 500, 3000],
    isNative: false,
  },
  POL: {
    tokenIn: WPOL_ADDR,
    decimals: 18,
    feeCandidates: [3000, 500, 10000],
    isNative: true,
  },
};

/**
 * Fetch on-chain balances for the authenticated EOA on Polygon.
 *
 * Returns USDC.e (tradeable), native USDC (swap needed), and POL (gas).
 * This is the user-facing balance — what `canon-cli balance` should show.
 *
 * Requires `POLYMARKET_PRIVATE_KEY`. Uses a public Polygon RPC.
 */
export async function fetchOnChainBalances(): Promise<OnChainBalance[]> {
  const privateKey = process.env["POLYMARKET_PRIVATE_KEY"];
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY required");

  const { ethers } = await import("ethers");
  const rpc = process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";
  const provider = new ethers.providers.StaticJsonRpcProvider(
    rpc,
    { name: "polygon", chainId: 137 },
  );
  const address = new ethers.Wallet(privateKey).address;

  const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
  const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const abi = ["function balanceOf(address) view returns (uint256)"];
  const usdcE = new ethers.Contract(USDC_E, abi, provider);
  const usdcNative = new ethers.Contract(USDC_NATIVE, abi, provider);

  const [polRaw, usdcERaw, usdcNativeRaw] = await Promise.all([
    provider.getBalance(address),
    usdcE["balanceOf"](address),
    usdcNative["balanceOf"](address),
  ]);

  const fmt6 = (v: { toString(): string }): number =>
    Number(ethers.utils.formatUnits(v.toString(), 6));
  const fmt18 = (v: { toString(): string }): number =>
    Number(ethers.utils.formatUnits(v.toString(), 18));

  const out: OnChainBalance[] = [
    {
      currency: "USDC.e",
      address: USDC_E,
      amount: fmt6(usdcERaw),
      tradeable: true,
    },
  ];

  const nativeAmt = fmt6(usdcNativeRaw);
  if (nativeAmt > 0) {
    out.push({
      currency: "USDC",
      address: USDC_NATIVE,
      amount: nativeAmt,
      tradeable: false,
      note: "native USDC — swap to USDC.e to trade on Polymarket",
    });
  }

  const USDT_ADDR = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
  const usdt = new ethers.Contract(USDT_ADDR, abi, provider);
  const usdtRaw = (await usdt["balanceOf"](address)) as { toString(): string };
  const usdtAmt = fmt6(usdtRaw);
  if (usdtAmt > 0) {
    out.push({
      currency: "USDT",
      address: USDT_ADDR,
      amount: usdtAmt,
      tradeable: false,
      note: "swap to USDC.e to trade on Polymarket",
    });
  }

  out.push({
    currency: "POL",
    address: "native",
    amount: fmt18(polRaw),
    tradeable: false,
    note: "for gas; excess can be swapped to USDC.e",
  });

  return out;
}

/**
 * Swap a supported asset (native USDC, USDT, or POL) to USDC.e on Uniswap v3.
 *
 * Required because Polymarket's CTFExchange only accepts USDC.e. Users who
 * fund the burner with native USDC / USDT / excess POL need a one-call
 * conversion path. Approves the swap router if allowance is insufficient.
 * Slippage tolerance is 0.5% (configurable via SWAP_SLIPPAGE_BPS env var).
 *
 * @param from - Source asset symbol.
 * @param amountIn - Amount to swap in human units (e.g. 5 = 5 USDC).
 */
export async function swapToUsdce(
  from: SwapSource,
  amountIn: number,
): Promise<SwapResult> {
  if (amountIn <= 0) throw new Error(`amountIn must be > 0, got ${amountIn}`);
  const privateKey = process.env["POLYMARKET_PRIVATE_KEY"];
  if (!privateKey) throw new Error("POLYMARKET_PRIVATE_KEY required");

  const route = SWAP_ROUTES[from];
  const slippageBps = Number(process.env["SWAP_SLIPPAGE_BPS"] ?? "50");
  if (!Number.isFinite(slippageBps) || slippageBps < 0 || slippageBps > 1000) {
    throw new Error(`SWAP_SLIPPAGE_BPS invalid: ${String(slippageBps)}`);
  }

  const { ethers } = await import("ethers");
  const rpc = process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";
  const provider = new ethers.providers.StaticJsonRpcProvider(
    rpc,
    { name: "polygon", chainId: 137 },
  );
  const signer = new ethers.Wallet(privateKey, provider);

  const amountInRaw = ethers.utils.parseUnits(
    amountIn.toFixed(route.decimals),
    route.decimals,
  );

  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits("50", "gwei");
  const tip = ethers.utils.parseUnits("30", "gwei");
  const feeOpts = {
    maxPriorityFeePerGas: tip,
    maxFeePerGas: baseFee.mul(2).add(tip),
  };

  let approveTxHash: string | undefined;
  if (!route.isNative) {
    const erc20 = new ethers.Contract(
      route.tokenIn,
      [
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
      ],
      signer,
    );
    const allow = (await erc20["allowance"](
      signer.address,
      SWAP_ROUTER,
    )) as { lt(other: unknown): boolean };
    if (allow.lt(amountInRaw)) {
      const approveTx = (await erc20["approve"](
        SWAP_ROUTER,
        ethers.constants.MaxUint256,
        { ...feeOpts, gasLimit: 100_000 },
      )) as { hash: string; wait(): Promise<unknown> };
      approveTxHash = approveTx.hash;
      await approveTx.wait();
    }
  }

  // Find a pool with liquidity and fetch a real quote via QuoterV2 staticCall.
  const quoter = new ethers.Contract(
    UNISWAP_QUOTER_V2,
    [
      "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)",
    ],
    provider,
  );
  let chosenFee = 0;
  let expectedOut: { toString(): string; mul(n: number): { div(n: number): unknown }} | undefined;
  for (const fee of route.feeCandidates) {
    try {
      const quoteFn = quoter.callStatic["quoteExactInputSingle"];
      if (!quoteFn) throw new Error("quoteExactInputSingle not on contract");
      const result = (await quoteFn({
        tokenIn: route.tokenIn,
        tokenOut: USDC_E_ADDR,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0,
      })) as readonly [{ toString(): string; mul(n: number): { div(n: number): unknown } }];
      const [amountOut] = result;
      chosenFee = fee;
      expectedOut = amountOut;
      break;
    } catch {
      continue;
    }
  }
  if (chosenFee === 0 || !expectedOut) {
    throw new Error(
      `No Uniswap v3 pool found for ${from} → USDC.e (tried fees ${route.feeCandidates.join(", ")})`,
    );
  }
  const minOut = expectedOut.mul(10_000 - slippageBps).div(10_000);

  const router = new ethers.Contract(
    SWAP_ROUTER,
    [
      "function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)",
    ],
    signer,
  );
  const params = [
    route.tokenIn,
    USDC_E_ADDR,
    chosenFee,
    signer.address,
    amountInRaw,
    minOut,
    0,
  ];
  const usdcE = new ethers.Contract(
    USDC_E_ADDR,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  );
  const beforeRaw = (await usdcE["balanceOf"](signer.address)) as {
    toString(): string;
  };

  const swapTx = (await router["exactInputSingle"](params, {
    ...feeOpts,
    ...(route.isNative ? { value: amountInRaw } : {}),
    gasLimit: 300_000,
  })) as { hash: string; wait(): Promise<{ logs: unknown[] }> };
  await swapTx.wait();

  const afterRaw = (await usdcE["balanceOf"](signer.address)) as {
    toString(): string;
  };
  const before = Number(ethers.utils.formatUnits(beforeRaw.toString(), 6));
  const after = Number(ethers.utils.formatUnits(afterRaw.toString(), 6));
  const amountOut = Number((after - before).toFixed(6));

  return {
    from,
    amountIn,
    amountOut,
    txHash: swapTx.hash,
    ...(approveTxHash !== undefined ? { approveTxHash } : {}),
  };
}
