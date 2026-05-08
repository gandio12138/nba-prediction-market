/**
 * Process-env accessors for the templates layer.
 *
 * Mirrors `canon/cli/env.ts`. The two packages keep separate copies
 * because canon/templates' tsconfig forbids importing from canon/cli
 * at compile time. Both helpers must agree on the canonical / legacy
 * pair — the integration tests in either package will catch drift.
 */

const WALLET_KEY = {
  modern: "WALLET_PRIVATE_KEY",
  legacy: "POLYMARKET_PRIVATE_KEY",
} as const;

const WALLET_PROXY = {
  modern: "WALLET_PROXY_ADDRESS",
  legacy: "POLYMARKET_PROXY_ADDRESS",
} as const;

const warned = new Set<string>();

function read(modern: string, legacy: string): string | undefined {
  const m = process.env[modern];
  if (m !== undefined && m.length > 0) return m;
  const l = process.env[legacy];
  if (l !== undefined && l.length > 0) {
    if (!warned.has(legacy)) {
      warned.add(legacy);
      process.stderr.write(
        `[canon] env ${legacy} is deprecated; export ${modern} instead ` +
          `(legacy fallback will be removed in a future release).\n`,
      );
    }
    return l;
  }
  return undefined;
}

/** Return the configured wallet private key, or undefined. */
export function getWalletPrivateKey(): string | undefined {
  return read(WALLET_KEY.modern, WALLET_KEY.legacy);
}

/** Return the configured wallet proxy / owner address, or undefined. */
export function getWalletProxyAddress(): string | undefined {
  return read(WALLET_PROXY.modern, WALLET_PROXY.legacy);
}

/** Reset the deprecation warning cache (test helper only). */
export function _resetEnvWarningsForTests(): void {
  warned.clear();
}
