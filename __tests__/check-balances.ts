import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const signer = new ethers.Wallet(process.env["WALLET_PRIVATE_KEY"]!);
const provider = new ethers.providers.StaticJsonRpcProvider("https://polygon.drpc.org", { name: "polygon", chainId: 137 });
const tokens = {
  "Native USDC (0x3c49)": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  "USDC.e bridged (0x2791)": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
};
for (const [name, addr] of Object.entries(tokens)) {
  const c = new ethers.Contract(addr, ["function balanceOf(address) view returns (uint256)"], provider);
  const b = await c["balanceOf"](signer.address);
  console.log(`${name}: ${ethers.utils.formatUnits(b, 6)}`);
}
const pol = await provider.getBalance(signer.address);
console.log(`POL: ${ethers.utils.formatUnits(pol, 18)}`);
