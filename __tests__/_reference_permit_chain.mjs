/**
 * REFERENCE — not a test. Filename starts with `_` so vitest skips it.
 *
 * Working prototype for the missing `OnboardClient.ensureFunded()` step.
 * Live-verified 2026-05-03 against a fresh, never-funded EOA on Polygon
 * (Safe `0x18eB…Eec7` ended with 9.83 pUSD; EOA never held POL).
 *
 * What it does, in one batched Safe tx via the gasless relayer:
 *   1. EOA signs an off-chain EIP-2612 permit allowing the Safe to spend
 *      the EOA's USDC.
 *   2. Safe calls `USDC.permit(EOA → Safe, amount, deadline, sig)` —
 *      sets allowance using the off-chain signature.
 *   3. Safe calls `USDC.transferFrom(EOA → Safe, amount)` — pulls funds.
 *   4. Safe approves Uniswap V3 SwapRouter on USDC.
 *   5. Safe swaps USDC → USDC.e via Uniswap V3 (exactInputSingle).
 *   6. Safe approves Polymarket Onramp on USDC.e.
 *   7. Safe wraps USDC.e → pUSD via Onramp.
 *
 * Why permit:
 *   The relayer pays gas only for *Safe-initiated* txs. Moving funds
 *   from the EOA into the Safe directly would require the EOA to pay
 *   gas (POL). EIP-2612 permit lets the Safe pull funds from the EOA
 *   using only an off-chain signature — the EOA never touches POL.
 *
 * To productionize:
 *   - Move into `polymarket-onboard.ts` as `ensureFunded(amount?)`.
 *   - Read the source asset from on-chain balance (auto-detect native
 *     USDC vs USDC.e) and skip the swap step when USDC.e is already on
 *     the EOA.
 *   - Quote the swap via QuoterV2 with try/catch over fee tiers
 *     (100, 500, 3000) — see canon's existing `swapToUsdce`.
 *   - Surface the deadline (default 1h) as a parameter.
 *   - Add a unit test mocking RelayClient.execute and verifying the
 *     7-call batch matches the spec.
 *   - Cover the "EOA balance < amount" and "Safe already has pUSD"
 *     branches in tests.
 *   - Persist `WALLET_PROXY_ADDRESS` to env / wallet-store after the
 *     Safe is deployed so subsequent canon calls (createOrder etc.)
 *     pick up the correct funder without manual config.
 *
 * To run this prototype:
 *   set -a; source canon/templates/.env; set +a
 *   pnpm --filter canon-templates exec tsx canon/templates/__tests__/_reference_permit_chain.mjs
 *
 * .env required:
 *   WALLET_PRIVATE_KEY              — funded EOA's PK (any small native USDC)
 *   POLYMARKET_BUILDER_API_KEY      — relayer needs builder auth
 *   POLYMARKET_BUILDER_SECRET
 *   POLYMARKET_BUILDER_PASSPHRASE
 */

import { readFileSync } from "node:fs";

// Load .env (no dotenv dep)
const envPath = new URL("../.env", import.meta.url);
try {
  const env = readFileSync(envPath, "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  // No .env — caller must export vars.
}

// Cloudflare-friendly UA (see canon/templates/clob-axios-defaults.ts)
const axios = (await import("axios")).default;
axios.defaults.headers.common["User-Agent"] =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const { Wallet, providers, Contract, utils, constants } = await import("ethers");
const { RelayClient, RelayerTxType, deriveSafe } = await import(
  "@polymarket/builder-relayer-client"
);
const { getContractConfig: relayerConfig } = await import(
  "@polymarket/builder-relayer-client/dist/config/index.js"
);
const { BuilderConfig } = await import("@polymarket/builder-signing-sdk");

const PK = process.env["WALLET_PRIVATE_KEY"];
if (!PK) throw new Error("WALLET_PRIVATE_KEY not set");

const POLYGON_CHAIN_ID = 137;
const RELAYER = process.env["POLYMARKET_RELAYER_URL"]
  ?? "https://relayer-v2.polymarket.com";
const RPC = process.env["POLYGON_RPC_URL"] ?? "https://polygon.drpc.org";

// Polygon mainnet addresses — read from getContractConfig where possible.
// These three (Onramp, Uniswap router, quoter) aren't in the SDK config.
const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_E      = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD        = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const ONRAMP      = "0x93070a847efEf7F70739046A929D47a521F5B8ee";
const SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER      = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

const provider = new providers.JsonRpcProvider(RPC, { name: "polygon", chainId: POLYGON_CHAIN_ID });
const wallet = new Wallet(PK, provider);
const safe = deriveSafe(wallet.address, relayerConfig(POLYGON_CHAIN_ID).SafeContracts.SafeFactory);
console.log("EOA:", wallet.address, " Safe:", safe);

// ---- read state ----
const usdc = new Contract(USDC_NATIVE, [
  "function balanceOf(address) view returns (uint256)",
  "function nonces(address) view returns (uint256)",
], provider);
const value = await usdc.balanceOf(wallet.address);
const nonce = await usdc.nonces(wallet.address);
console.log("EOA USDC:", utils.formatUnits(value, 6), "nonce:", nonce.toString());
if (value.eq(0)) {
  console.log("Nothing to fund. Send native USDC to EOA first.");
  process.exit(0);
}

// ---- sign EIP-2612 permit ----
const deadline = Math.floor(Date.now() / 1000) + 3600;
const domain = {
  name: "USD Coin", version: "2",
  chainId: POLYGON_CHAIN_ID, verifyingContract: USDC_NATIVE,
};
const types = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
const sig = await wallet._signTypedData(domain, types, {
  owner: wallet.address,
  spender: safe,
  value: value.toString(),
  nonce: nonce.toString(),
  deadline,
});
const { r: pr, s: ps, v: pv } = utils.splitSignature(sig);

// ---- quote the swap (try fee tiers) ----
const quoter = new Contract(QUOTER, [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)",
], provider);
let chosenFee, expectedOut;
for (const fee of [100, 500, 3000]) {
  try {
    const q = await quoter.callStatic.quoteExactInputSingle({
      tokenIn: USDC_NATIVE, tokenOut: USDC_E,
      amountIn: value, fee, sqrtPriceLimitX96: 0,
    });
    chosenFee = fee; expectedOut = q[0]; break;
  } catch { /* try next tier */ }
}
if (!expectedOut) throw new Error("no Uniswap pool found for USDC → USDC.e");
const minOut = expectedOut.mul(9950).div(10000); // 0.5% slippage

// ---- build the 6-call Safe batch ----
const erc20 = new utils.Interface([
  "function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
  "function transferFrom(address,address,uint256) returns (bool)",
  "function approve(address,uint256)",
]);
const router = new utils.Interface([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
]);
const onramp = new utils.Interface(["function wrap(address,address,uint256)"]);

const txs = [
  { to: USDC_NATIVE, operation: 0, value: "0",
    data: erc20.encodeFunctionData("permit",
      [wallet.address, safe, value, deadline, pv, pr, ps]) },
  { to: USDC_NATIVE, operation: 0, value: "0",
    data: erc20.encodeFunctionData("transferFrom",
      [wallet.address, safe, value]) },
  { to: USDC_NATIVE, operation: 0, value: "0",
    data: erc20.encodeFunctionData("approve",
      [SWAP_ROUTER, constants.MaxUint256]) },
  { to: SWAP_ROUTER, operation: 0, value: "0",
    data: router.encodeFunctionData("exactInputSingle", [{
      tokenIn: USDC_NATIVE, tokenOut: USDC_E, fee: chosenFee, recipient: safe,
      deadline: Math.floor(Date.now() / 1000) + 600,
      amountIn: value, amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
    }]) },
  { to: USDC_E, operation: 0, value: "0",
    data: erc20.encodeFunctionData("approve",
      [ONRAMP, constants.MaxUint256]) },
  { to: ONRAMP, operation: 0, value: "0",
    data: onramp.encodeFunctionData("wrap",
      [USDC_E, safe, minOut]) },
];

// ---- execute via relayer ----
const builderConfig = new BuilderConfig({
  localBuilderCreds: {
    key: process.env["POLYMARKET_BUILDER_API_KEY"],
    secret: process.env["POLYMARKET_BUILDER_SECRET"],
    passphrase: process.env["POLYMARKET_BUILDER_PASSPHRASE"],
  },
});
const relay = new RelayClient(RELAYER, POLYGON_CHAIN_ID, wallet, builderConfig, RelayerTxType.SAFE);
console.log(`submitting ${txs.length}-call Safe batch (permit + transferFrom + swap + wrap)…`);
const submission = await relay.execute(txs, "canon: ensureFunded — permit + transfer + swap + wrap");
const result = await submission.wait();
console.log("state:", result?.state, "tx:", result?.transactionHash);

// ---- verify ----
const pusd = new Contract(PUSD, ["function balanceOf(address) view returns (uint256)"], provider);
const usdce = new Contract(USDC_E, ["function balanceOf(address) view returns (uint256)"], provider);
console.log("\nFINAL:");
console.log("  Safe pUSD:   ", utils.formatUnits(await pusd.balanceOf(safe), 6));
console.log("  Safe USDC.e: ", utils.formatUnits(await usdce.balanceOf(safe), 6));
console.log("  EOA USDC:    ", utils.formatUnits(await usdc.balanceOf(wallet.address), 6));
