/**
 * Auto-discover the Polymarket gnosis-safe proxy address for an EOA.
 *
 * pmxt-core 2.22.1's discoverProxy() calls
 * https://data-api.polymarket.com/profiles/<eoa> which now returns 404.
 * The polymarket.com profile page itself still embeds the migrated
 * proxy in its Next.js SSR JSON payload — scrape it from there.
 *
 * Behaviour:
 *   - Returns the proxy address when the EOA has been migrated.
 *   - Returns `undefined` when the page echoes the EOA back (i.e. no
 *     proxy / not migrated). Callers should treat this as "use EOA
 *     signature type".
 *
 * Network failures are swallowed and reported as `undefined` so the
 * caller can fall back to whatever the operator put in the env.
 */

const PROFILE_URL = "https://polymarket.com/profile/";
const REQUEST_TIMEOUT_MS = 10_000;

/** Outcome of a proxy-discovery lookup. */
export interface ProxyDiscoveryResult {
  /** The discovered gnosis-safe proxy address, or `undefined`. */
  proxyAddress: string | undefined;
  /** `"gnosis-safe"` when a proxy was discovered; `"eoa"` otherwise. */
  signatureType: "gnosis-safe" | "eoa";
}

function eqAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Fetch the profile page for an EOA and extract its proxyAddress.
 *
 * @param eoa - The signer wallet address (0x-prefixed, 40 hex chars).
 */
export async function discoverPolymarketProxy(
  eoa: string,
): Promise<ProxyDiscoveryResult> {
  const fallback: ProxyDiscoveryResult = {
    proxyAddress: undefined,
    signatureType: "eoa",
  };

  if (!/^0x[0-9a-fA-F]{40}$/.test(eoa)) {
    return fallback;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let html: string;
  try {
    const res = await fetch(`${PROFILE_URL}${eoa}`, {
      headers: { "User-Agent": "canon-templates (proxy-discovery)" },
      signal: controller.signal,
    });
    if (!res.ok) return fallback;
    html = await res.text();
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }

  // Next.js SSR page embeds JSON props with `"proxyAddress":"0x..."`.
  // Backslash-escapes are used inside double-encoded JSON; match either form.
  const match =
    /\\?"proxyAddress\\?"\s*:\s*\\?"(0x[0-9a-fA-F]{40})\\?"/.exec(html);
  if (!match || !match[1]) return fallback;

  const candidate = match[1];
  if (eqAddress(candidate, eoa)) return fallback;
  return { proxyAddress: candidate, signatureType: "gnosis-safe" };
}
