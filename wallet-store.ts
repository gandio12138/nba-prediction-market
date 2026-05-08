/**
 * Wallet store — interface + file-backed implementation owned by the
 * templates layer.
 *
 * The templates package can't statically import from `canon/cli` (the
 * package's `tsconfig.json` enforces `rootDir: "."`), and a runtime
 * dynamic import into a sibling package breaks the moment a project
 * is scaffolded out (the relative path no longer resolves). Owning a
 * minimal `FileWalletStore` here lets every strategy `entry.ts` use a
 * plain static import that resolves identically in the source repo
 * and in any scaffolded project.
 *
 * The canon-cli package keeps its own richer `FileWalletStore` for CLI
 * write paths (`ensure`, `setEnv`, `loadEnvIntoProcess`); strategies
 * only need read access to the private key, so the templates impl is
 * intentionally smaller and read-only. Both implementations share the
 * same `.canon/wallet.env` on disk.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WalletStore {
  /** True when the underlying store has a usable wallet. */
  hasWallet(): boolean;
  /** Return the raw private key (hex). Throws when no wallet exists. */
  getPrivateKey(): string;
  /** Return the wallet's checksummed address. */
  getAddress(): Promise<string>;
}

export class WalletNotFoundError extends Error {
  constructor() {
    super(
      "No wallet found at .canon/wallet.env. " +
        "Run 'canon-cli wallet ensure' to generate one.",
    );
    this.name = "WalletNotFoundError";
  }
}

const KEY_NAME = "WALLET_PRIVATE_KEY";
const LEGACY_KEY_NAME = "POLYMARKET_PRIVATE_KEY";

/**
 * Read-only project-local wallet store backed by `.canon/wallet.env`.
 *
 * @param rootDir Project root; defaults to `process.cwd()`.
 */
export class FileWalletStore implements WalletStore {
  private readonly path: string;

  constructor(rootDir: string = process.cwd()) {
    this.path = join(rootDir, ".canon", "wallet.env");
  }

  hasWallet(): boolean {
    return this.readKey() !== undefined;
  }

  getPrivateKey(): string {
    const key = this.readKey();
    if (key === undefined) throw new WalletNotFoundError();
    return key;
  }

  async getAddress(): Promise<string> {
    const key = this.getPrivateKey();
    const { Wallet } = await import("ethers");
    return new Wallet(key).address;
  }

  private readKey(): string | undefined {
    if (!existsSync(this.path)) return undefined;
    const text = readFileSync(this.path, "utf8");
    let modern: string | undefined;
    let legacy: string | undefined;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const name = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (value.length === 0) continue;
      if (name === KEY_NAME) modern = value;
      else if (name === LEGACY_KEY_NAME) legacy = value;
    }
    if (modern !== undefined) return modern;
    if (legacy !== undefined) {
      warnLegacyKeyOnce(this.path);
      return legacy;
    }
    return undefined;
  }
}

let legacyKeyWarned = false;
function warnLegacyKeyOnce(path: string): void {
  if (legacyKeyWarned) return;
  legacyKeyWarned = true;
  process.stderr.write(
    `[canon] ${path}: ${LEGACY_KEY_NAME} is deprecated; ` +
      `rename the line to ${KEY_NAME} (back-compat will be dropped in a future release).\n`,
  );
}
