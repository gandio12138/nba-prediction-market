import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const line of env.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && m[1] && !process.env[m[1]]) process.env[m[1]] = m[2];
}
console.log("key loaded, length:", process.env["WALLET_PRIVATE_KEY"]?.length);

const { fetchBalance, fetchPositions } = await import("../client-polymarket.js");

console.log("fetchBalance (unfunded)...");
try {
  const bal = await fetchBalance();
  console.log("  →", JSON.stringify(bal));
} catch (e) {
  console.error("  FAIL:", e instanceof Error ? e.message : String(e));
}

console.log("fetchPositions (unfunded)...");
try {
  const pos = await fetchPositions();
  console.log(`  → ${pos.length} positions`);
} catch (e) {
  console.error("  FAIL:", e instanceof Error ? e.message : String(e));
}
process.exit(0);
