import { searchMarkets, fetchOrderBook } from "../client-polymarket.js";

const query = process.argv[2] ?? "NBA";
console.log(`searchMarkets("${query}")...`);
const matches = await searchMarkets(query);
console.log(`  → ${matches.length} markets`);
const first = matches[0];
if (!first) {
  console.log("no markets returned; exiting");
  process.exit(0);
}
console.log(`  first: ${first.question}`);
console.log(`         yes=${first.yesPrice} no=${first.noPrice}`);
console.log(`         yesTokenId=${first.yesTokenId}`);

console.log(`fetchOrderBook(${first.yesTokenId})...`);
const book = await fetchOrderBook(first.yesTokenId);
console.log(`  bids=${book.bids.length} asks=${book.asks.length}`);
if (book.bids[0]) console.log(`  top bid: ${book.bids[0].price} x ${book.bids[0].size}`);
if (book.asks[0]) console.log(`  top ask: ${book.asks[0].price} x ${book.asks[0].size}`);
process.exit(0);
