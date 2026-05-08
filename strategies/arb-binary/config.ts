/**
 * ARB-01 Binary Arbitrage — Configuration
 *
 * C2 production defaults for the binary arbitrage strategy.
 * Category is required — no scan-all mode.
 */

import type { ArbBinaryConfig } from "./signal.js";

/** C2 production defaults for ARB-01 binary arbitrage. */
export const DEFAULT_ARB_BINARY_CONFIG: ArbBinaryConfig = {
  category: "NBA Champion",
  kellyFraction: 0.25,
  maxExposure: 0.08,
  hurdleRate: 0.015,
  feeRate: 0.02,
  gasCost: 0.02,
  slippageAbort: 0.003,
  bankroll: 10_000,
  signalTtlMs: 5_000,
};
