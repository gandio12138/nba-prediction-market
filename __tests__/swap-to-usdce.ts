import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const USDC_NATIVE = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // Uniswap SwapRouter02

const provider = new ethers.providers.StaticJsonRpcProvider("https://polygon.drpc.org", { name: "polygon", chainId: 137 });
const signer = new ethers.Wallet(process.env["WALLET_PRIVATE_KEY"]!, provider);

const erc20 = (addr: string) =>
  new ethers.Contract(
    addr,
    [
      "function approve(address,uint256) returns (bool)",
      "function allowance(address,address) view returns (uint256)",
      "function balanceOf(address) view returns (uint256)",
    ],
    signer,
  );

const usdcNative = erc20(USDC_NATIVE);
const usdcE = erc20(USDC_E);

const feeOpts = async () => {
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits("50", "gwei");
  const tip = ethers.utils.parseUnits("30", "gwei");
  return { maxPriorityFeePerGas: tip, maxFeePerGas: baseFee.mul(2).add(tip) };
};

// 1. Approve router
const curAllow = await usdcNative["allowance"](signer.address, ROUTER);
const bal = await usdcNative["balanceOf"](signer.address);
console.log(`native USDC balance: ${ethers.utils.formatUnits(bal, 6)}`);
if (curAllow.lt(bal)) {
  console.log("approving router...");
  const t = await usdcNative["approve"](ROUTER, ethers.constants.MaxUint256, { ...(await feeOpts()), gasLimit: 100_000 });
  console.log("  tx:", t.hash);
  await t.wait();
  console.log("  mined");
}

// 2. Swap (exactInputSingle)
const router = new ethers.Contract(
  ROUTER,
  ["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) payable returns (uint256)"],
  signer,
);
const amountIn = bal; // swap entire balance
const amountOutMin = amountIn.mul(9990).div(10000); // allow up to 0.1% slippage
const params = [
  USDC_NATIVE,
  USDC_E,
  100, // 0.01% fee tier
  signer.address,
  amountIn,
  amountOutMin,
  0,
];
console.log("swapping...");
const swapTx = await router["exactInputSingle"](params, { ...(await feeOpts()), gasLimit: 300_000 });
console.log("  tx:", swapTx.hash);
const rcpt = await swapTx.wait();
console.log(`  mined block ${rcpt.blockNumber}`);

const bal2 = await usdcE["balanceOf"](signer.address);
console.log(`USDC.e balance after swap: ${ethers.utils.formatUnits(bal2, 6)}`);
