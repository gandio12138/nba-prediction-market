import { searchMarkets, fetchOHLCV, watchOrderBook } from "../client-polymarket.js";

const markets = await searchMarkets("NBA");
const m = markets.find((x) => x.yesTokenId);
if (!m) {
  console.error("no market with tokenId");
  process.exit(1);
}
console.log(`market: ${m.question}`);
console.log(`token:  ${m.yesTokenId}`);

console.log("fetchOHLCV 1h...");
try {
  const candles = await fetchOHLCV(m.yesTokenId, { timeframe: "1h" });
  console.log(`  → ${candles.length} candles`);
  const last = candles.at(-1);
  if (last) console.log(`  last: o=${last.open} h=${last.high} l=${last.low} c=${last.close} ts=${last.timestamp}`);
} catch (e) {
  console.error("  FAIL:", e instanceof Error ? e.message : String(e));
}

console.log("watchOrderBook...");
try {
  const book = await watchOrderBook(m.yesTokenId);
  console.log(`  → bids=${book.bids.length} asks=${book.asks.length} ts=${book.timestamp}`);
} catch (e) {
  console.error("  FAIL:", e instanceof Error ? e.message : String(e));
}
process.exit(0);
