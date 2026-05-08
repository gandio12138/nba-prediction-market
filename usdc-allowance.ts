/**
 * USDC allowance adapter for the Polymarket CTFExchange.
 *
 * Concrete `AllowanceClient` implementation backed by an ethers v5
 * provider + signer. Reads the current ERC-20 allowance the connected
 * wallet has granted to the exchange spender, and submits an
 * `approve()` transaction when the live executor's threshold check
 * decides a top-up is needed.
 */
import { Contract } from "ethers";
import type { AllowanceClient } from "./live-executor.js";

/** Minimal ERC-20 ABI fragments needed for allowance + approve. */
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

/** Ethers-v5-style provider/signer surface needed by the adapter. */
export interface UsdcAllowanceConfig {
  /** Wallet address (the allowance owner). */
  ownerAddress: string;
  /** Spender that the allowance is granted to (Polymarket CTFExchange). */
  spenderAddress: string;
  /** USDC.e contract address on Polygon. */
  usdcAddress: string;
  /**
   * Hook that returns the configured wallet/signer used to send
   * `approve()` transactions. Kept abstract to avoid coupling the
   * templates layer to a concrete wallet store at import time.
   */
  getSigner: () => Promise<unknown>;
  /**
   * Hook that returns a read-only provider for `allowance(...)` calls.
   */
  getProvider: () => Promise<unknown>;
}

/** Shape returned by ethers v5 `allowance()` (BigNumber). */
interface BigNumberLike {
  toBigInt: () => bigint;
}

function isBigNumberLike(value: unknown): value is BigNumberLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toBigInt?: unknown }).toBigInt === "function"
  );
}

/**
 * Build a USDC allowance adapter for the live executor.
 *
 * - `getAllowance()` calls USDC `allowance(owner, spender)` via the
 *   provider and returns the raw 6-decimal `bigint`.
 * - `approve(amount)` submits `approve(spender, amount)` via the
 *   signer, awaits one confirmation, and returns `{ txHash }`.
 */
export function createUsdcAllowanceClient(
  config: UsdcAllowanceConfig,
): AllowanceClient {
  return {
    async getAllowance(): Promise<bigint> {
      const provider = await config.getProvider();
      const contract = new Contract(
        config.usdcAddress,
        ERC20_ABI,
        provider as never,
      );
      const raw: unknown = await (
        contract as unknown as {
          allowance: (owner: string, spender: string) => Promise<unknown>;
        }
      ).allowance(config.ownerAddress, config.spenderAddress);
      if (typeof raw === "bigint") {
        return raw;
      }
      if (isBigNumberLike(raw)) {
        return raw.toBigInt();
      }
      throw new TypeError(
        `usdc-allowance: unexpected allowance() return type (${typeof raw})`,
      );
    },
    async approve(amount: bigint): Promise<{ txHash: string }> {
      const signer = await config.getSigner();
      const contract = new Contract(
        config.usdcAddress,
        ERC20_ABI,
        signer as never,
      );
      const tx = (await (
        contract as unknown as {
          approve: (
            spender: string,
            amount: bigint,
          ) => Promise<{ hash: string; wait: () => Promise<unknown> }>;
        }
      ).approve(config.spenderAddress, amount)) satisfies {
        hash: string;
        wait: () => Promise<unknown>;
      };
      await tx.wait();
      return { txHash: tx.hash };
    },
  };
}
