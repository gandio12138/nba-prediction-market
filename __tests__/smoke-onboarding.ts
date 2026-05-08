/**
 * Live smoke harness for the Polymarket onboarding adapter.
 *
 * Drives the full onboarding chain against a real funded EOA on Polygon,
 * submits a 5-share GTC limit @ $0.01 on the first matched market, cancels
 * it, and prints the order id. Validates that the Safe deployed by
 * `polymarketOnboard.ensureFunder()` is actually trade-eligible end-to-end —
 * something the unit tests can't assert because they mock the SDKs.
 *
 * Skipped by default. Set `RUN_LIVE=1` to opt in. Filename ends in `.ts`
 * (not `.test.ts`) so vitest excludes it from CI runs.
 *
 * Required env (only when RUN_LIVE=1):
 *   - WALLET_PRIVATE_KEY — funded EOA on Polygon (USDC.e + a little POL).
 *
 * Optional env:
 *   - SMOKE_MARKET_QUERY  — search term for the test market (default "NBA").
 *   - POLYGON_RPC_URL     — overrides the public Polygon RPC.
 *   - POLYMARKET_RELAYER_URL / POLYMARKET_CLOB_HOST — staging overrides.
 *
 * Manual run:
 *   RUN_LIVE=1 pnpm --filter canon-templates exec tsx __tests__/smoke-onboarding.ts
 */

import { polymarketOnboard } from "../polymarket-onboard.js";
import {
  cancelOrder,
  createOrder,
  searchMarkets,
} from "../client-polymarket.js";

if (process.env["RUN_LIVE"] !== "1") {
  console.log(
    "smoke-onboarding: skipped (set RUN_LIVE=1 to opt in; this script places a real order)",
  );
  process.exit(0);
}

const pk = process.env["WALLET_PRIVATE_KEY"];
if (pk === undefined || pk.length === 0) {
  console.error(
    "smoke-onboarding: WALLET_PRIVATE_KEY required (export a funded test EOA's private key)",
  );
  process.exit(1);
}

const query = process.env["SMOKE_MARKET_QUERY"] ?? "NBA";

async function main(privateKey: string): Promise<void> {
  console.log("=== onboarding chain ===");
  const onboard = polymarketOnboard.build(privateKey);

  const before = await onboard.status();
  console.log(`status (pre): ${JSON.stringify(before)}`);
  console.log(`funderAddress: ${before.funderAddress}`);

  const funder = await onboard.ensureFunder();
  console.log(
    `ensureFunder: deployed=${String(funder.deployed)}` +
      (funder.txHash !== undefined ? ` tx=${funder.txHash}` : ""),
  );

  const approvals = await onboard.ensureApprovals();
  console.log(
    `ensureApprovals: approved=${String(approvals.approved)}` +
      (approvals.txHash !== undefined ? ` tx=${approvals.txHash}` : ""),
  );

  const creds = await onboard.ensureCreds();
  console.log(
    `ensureCreds: key=${creds.key.slice(0, 8)}... (secret/passphrase present)`,
  );

  // Optional permit-chain funding — opt in with RUN_FUND=1 when the EOA
  // holds native USDC and you want the smoke to verify the full path
  // EOA→Safe in one shot. Without this flag the smoke assumes the Safe
  // is already funded out-of-band.
  if (process.env["RUN_FUND"] === "1") {
    const funded = await onboard.ensureFunded();
    console.log(
      `ensureFunded: funded=${String(funded.funded)}` +
        ` amount=${funded.amount.toString()}` +
        ` expectedOut=${funded.expectedOut.toString()}` +
        (funded.txHash !== undefined ? ` tx=${funded.txHash}` : ""),
    );
  }

  const after = await onboard.status();
  console.log(`status (post): ${JSON.stringify(after)}`);

  if (!after.funderDeployed || !after.approvalsReady || !after.credsReady) {
    throw new Error(
      "onboarding did not converge — refusing to place a real order " +
        `(funderDeployed=${String(after.funderDeployed)}, ` +
        `approvalsReady=${String(after.approvalsReady)}, ` +
        `credsReady=${String(after.credsReady)})`,
    );
  }
  if (after.fundedCollateral <= 0) {
    throw new Error(
      `funder ${after.funderAddress} has zero collateral — fund it before re-running ` +
        "(send USDC.e on Polygon)",
    );
  }

  // pmxtjs's order path resolves the funder via WALLET_PROXY_ADDRESS. The
  // Safe just deployed by ensureFunder() IS the funder for subsequent orders,
  // so route the SDK at it explicitly — without this hint the SDK falls back
  // to EOA mode and the order would be signed with the wrong funder field.
  process.env["WALLET_PROXY_ADDRESS"] = after.funderAddress;

  console.log("=== place order ===");
  const matches = await searchMarkets(query);
  const market = matches[0];
  if (!market) {
    throw new Error(`no markets matched "${query}" — try a different SMOKE_MARKET_QUERY`);
  }
  console.log(`market:  ${market.question}`);
  console.log(`tokenId: ${market.yesTokenId}`);

  const order = await createOrder({
    marketId: market.conditionId,
    tokenId: market.yesTokenId,
    side: "buy",
    size: 5,
    price: 0.01,
    orderType: "limit",
    timeInForce: "GTC",
  });
  console.log(`orderId: ${order.id}`);
  console.log(
    `order:   status=${order.status} filled=${String(order.filled)} remaining=${String(order.remaining)}`,
  );

  console.log("=== cancel order ===");
  const cancel = await cancelOrder(order.id);
  console.log(`cancel:  id=${cancel.id} status=${cancel.status}`);

  console.log("=== smoke OK ===");
}

try {
  await main(pk);
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(`smoke-onboarding: FAIL — ${msg}`);
  process.exit(1);
}
