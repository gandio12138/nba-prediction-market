/**
 * Side-effect module: install a browser-shaped User-Agent on axios's global
 * defaults so requests from `@polymarket/clob-client-v2` and
 * `@polymarket/builder-relayer-client` clear Cloudflare's bot challenge
 * on `clob.polymarket.com`.
 *
 * Why this exists:
 *   Polymarket fronts the CLOB with Cloudflare. The default SDK User-Agent
 *   `@polymarket/clob-client` matches CF's "automated client" heuristic and
 *   is silently 403'd before the request reaches Polymarket's app servers.
 *   In a browser the SDK rides on top of an existing CF session and never
 *   sees the challenge; cold Node processes do.
 *
 *   Verified live 2026-05-03: a fresh wallet that 403'd consistently on
 *   `createApiKey` / `derive-api-key` started succeeding on the first try
 *   after this override.
 *
 * Why a side-effect import:
 *   Both SDKs read `axios.defaults.headers.common["User-Agent"]` at request
 *   time, so mutating defaults once at startup is enough — no per-call
 *   plumbing, no SDK fork. Import this module before constructing any
 *   ClobClient or RelayClient.
 *
 * Override:
 *   Set `CLOB_USER_AGENT` in env to a different UA if Polymarket's CF rules
 *   ever update and Mozilla/Chrome stops working.
 */
import axios from "axios";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const ua = process.env["CLOB_USER_AGENT"] ?? DEFAULT_UA;
axios.defaults.headers.common["User-Agent"] = ua;
