/**
 * Direct HTTP helper for the pmxt sidecar.
 *
 * Bypasses the pmxtjs SDK to work around the header-clobbering bug
 * in the generated OpenAPI client (pmxtjs v2.22.1).
 * Affected methods: fetchOHLCV, watchOrderBook, watchTrades.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Shape of ~/.pmxt/server.lock written by the pmxt-core sidecar. */
export interface SidecarLockData {
  port: number;
  pid: number;
  accessToken: string;
}

/** The pmxt sidecar is not running (lock file missing or unreadable). */
export class SidecarNotRunningError extends Error {
  constructor(cause: unknown) {
    super(
      "pmxt sidecar is not running — lock file not found at ~/.pmxt/server.lock",
      { cause },
    );
    this.name = "SidecarNotRunningError";
  }
}

/**
 * Time-in-force values forwarded over the wire to the sidecar.
 *
 * The sidecar accepts an optional `tif` field on `createOrder` payloads
 * and forwards it to `@polymarket/clob-client`. Older sidecars that do
 * not understand `tif` ignore the field; use {@link getSidecarCapabilities}
 * to detect support before relying on FOK semantics.
 */
export type SidecarTif = "GTC" | "IOC" | "FOK";

/**
 * Wire shape for `createOrder` calls to the sidecar.
 *
 * `tif` is optional and only meaningful for limit orders.
 */
export interface SidecarCreateOrderPayload {
  marketId: string;
  outcomeId: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: number;
  price: number;
  tif?: SidecarTif;
}

/** Feature flags advertised by the pmxt sidecar. */
export interface SidecarCapabilities {
  /** True when the sidecar forwards `tif` (GTC/IOC/FOK) to the exchange. */
  supportsTif: boolean;
}

/** The sidecar returned a non-OK HTTP response. */
export class SidecarRequestError extends Error {
  readonly status: number;
  readonly method: string;

  constructor(method: string, status: number, body: string) {
    super(`Sidecar ${method} failed (${String(status)}): ${body}`);
    this.name = "SidecarRequestError";
    this.status = status;
    this.method = method;
  }
}

async function readLockFile(): Promise<SidecarLockData> {
  const lockPath = join(homedir(), ".pmxt", "server.lock");

  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch (err: unknown) {
    throw new SidecarNotRunningError(err);
  }

  const data: unknown = JSON.parse(raw);

  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as Record<string, unknown>)["port"] !== "number" ||
    typeof (data as Record<string, unknown>)["accessToken"] !== "string"
  ) {
    throw new Error(
      "Invalid sidecar lock file: missing port or accessToken",
    );
  }

  return data as SidecarLockData;
}

/**
 * Call a pmxt sidecar HTTP endpoint directly.
 *
 * Reads the lock file at ~/.pmxt/server.lock, POSTs to the sidecar,
 * and returns the parsed JSON response.
 *
 * @param method - Sidecar API method name (e.g. "fetchOHLCV").
 * @param args - Arguments forwarded to the sidecar method.
 */
export async function callSidecar<T>(
  method: string,
  args: ReadonlyArray<unknown>,
  credentials?: {
    privateKey: string;
    signatureType?: string;
    funderAddress?: string;
  },
): Promise<T> {
  const lock = await readLockFile();

  const url = `http://localhost:${String(lock.port)}/api/polymarket/${method}`;
  const body: Record<string, unknown> = { args };
  if (credentials) body["credentials"] = credentials;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-pmxt-access-token": lock.accessToken,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new SidecarRequestError(method, response.status, body);
  }

  const json = (await response.json()) as Record<string, unknown>;

  // The sidecar wraps responses in { success, data }; unwrap if present.
  const result: unknown =
    json["success"] !== undefined ? json["data"] : json;
  return result as T;
}

/**
 * Query the sidecar for advertised feature flags.
 *
 * pmxt-core (all 2.x versions through 2.37.x) does not implement a
 * `getCapabilities` method — the sidecar replies with
 * `success: false, error: "Method 'getCapabilities' not found"`. That
 * is not the same as an unsupported sidecar: pmxt-core's polymarket
 * adapter calls `@polymarket/clob-client`'s `postOrder()` which
 * **defaults to GTC** for every limit order. Treat the missing method
 * as "supportsTif: true" so live-mode preflights don't pessimistically
 * refuse to run.
 *
 * If the sidecar ever starts implementing the method, this helper
 * still honours whatever it returns.
 */
export async function getSidecarCapabilities(): Promise<SidecarCapabilities> {
  try {
    const caps = await callSidecar<Partial<SidecarCapabilities>>(
      "getCapabilities",
      [],
    );
    return {
      supportsTif: caps.supportsTif === true,
    };
  } catch (err: unknown) {
    if (err instanceof SidecarRequestError) {
      // pmxt-core's "Method not found" surfaces as a SidecarRequestError.
      // pmxt-core's polymarket adapter unconditionally submits limit
      // orders via @polymarket/clob-client's postOrder(), whose tif
      // default is GTC — the semantic the preflight cares about.
      const body = err.message.toLowerCase();
      if (body.includes("method") && body.includes("not found")) {
        return { supportsTif: true };
      }
      return { supportsTif: false };
    }
    throw err;
  }
}
