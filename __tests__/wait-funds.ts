import { ethers } from "ethers";

const ADDR = "0x7b2d23fd477bbC52D98620cD36e2EAa470e0fC8C";
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const RPC = "https://polygon.drpc.org";

const provider = new ethers.providers.StaticJsonRpcProvider(RPC, { name: "polygon", chainId: 137 });
const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], provider);
const formatUnits = ethers.utils.formatUnits;

const MAX_TRIES = 30;
for (let i = 1; i <= MAX_TRIES; i++) {
  try {
    const [pol, bal] = await Promise.all([
      provider.getBalance(ADDR),
      usdc["balanceOf"](ADDR),
    ]);
    const polStr = formatUnits(pol, 18);
    const usdcStr = formatUnits(bal, 6);
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] try ${i}/${MAX_TRIES}  POL=${polStr}  USDC=${usdcStr}`);
    if (pol.gt(0) && bal.gt(0)) {
      console.log("FUNDED");
      process.exit(0);
    }
  } catch (e) {
    console.error(`try ${i}: RPC error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (i < MAX_TRIES) await new Promise((r) => setTimeout(r, 60_000));
}
console.error("TIMEOUT — funds not arrived in 30 min");
process.exit(1);
