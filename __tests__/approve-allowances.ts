import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const provider = new ethers.providers.StaticJsonRpcProvider("https://polygon.drpc.org", { name: "polygon", chainId: 137 });
const signer = new ethers.Wallet(process.env["WALLET_PRIVATE_KEY"]!, provider);
const usdc = new ethers.Contract(
  USDC,
  [
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)",
  ],
  signer,
);
const MAX = ethers.constants.MaxUint256;

for (const [name, spender] of [
  ["CTF Exchange", CTF_EXCHANGE],
  ["NegRisk Exchange", NEG_RISK_EXCHANGE],
  ["NegRisk Adapter", NEG_RISK_ADAPTER],
] as const) {
  const current = await usdc["allowance"](signer.address, spender);
  if (current.gte(MAX.div(2))) {
    console.log(`${name}: already approved`);
    continue;
  }
  console.log(`${name}: approving... (spender ${spender})`);
  const block = await provider.getBlock("latest");
  const baseFee = block.baseFeePerGas ?? ethers.utils.parseUnits("50", "gwei");
  const tip = ethers.utils.parseUnits("30", "gwei");
  const maxFee = baseFee.mul(2).add(tip);
  const tx = await usdc["approve"](spender, MAX, {
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    gasLimit: 100_000,
  });
  console.log(`  tx: ${tx.hash}`);
  const rcpt = await tx.wait();
  console.log(`  mined block ${rcpt.blockNumber} gas=${rcpt.gasUsed.toString()}`);
}
console.log("done");
