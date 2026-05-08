/**
 * MINT-01 Simple Mint Cycle — Pure Functions
 *
 * Three pure helpers that drive a MINT-01 cycle:
 *
 *   1. `selectMarket`   — filter + rank candidate markets against the
 *                          MINT-01 config thresholds (volume, open interest,
 *                          time-to-close); pick the most liquid survivor.
 *   2. `planLegs`       — given a YES midpoint and the configured premium
 *                          offset, derive the two sell-limit prices and the
 *                          size (token units) for each leg.
 *   3. `shouldStopLoss` — given entry vs current YES midpoint and the drift
 *                          threshold, decide whether to cancel both legs.
 *
 * No I/O, no hidden state — these functions are deterministic and exercised
 * directly from `__tests__/cycle.test.ts`. `entry.ts` (Item 4) composes them
 * with the live-executor and `ctf-mint` SDK wrappers.
 */

import type { Mint01Config } from "./config.js";

/**
 * Candidate market input to `selectMarket`.
 *
 * Field names support snake_case (per C2 source spec) and camelCase (per
 * canon scanner conventions), matching the dual-shape pattern in
 * `mm-premium/signal.ts`.
 */
export interface MarketCandidate {
  /** Polymarket condition ID. */
  conditionId: string;
  /** Human-readable market question. */
  question: string;
  /** YES outcome midpoint price in [0, 1]. */
  midpoint: number;
  /** Milliseconds until market close. */
  timeToCloseMs: number;
  /** 24h quote volume in USD (snake_case variant). */
  volume_24h?: number;
  /** 24h quote volume in USD (camelCase variant). */
  volume24h?: number;
  /** Open interest in USD (snake_case variant). */
  open_interest?: number;
  /** Open interest in USD (camelCase variant). */
  openInterest?: number;
  /** CLOB token ID for the YES outcome. */
  yesTokenId?: string;
  /** CLOB token ID for the NO outcome. */
  noTokenId?: string;
}

/** A market that passed `selectMarket` filters, with ranking signal preserved. */
export interface MarketChoice {
  /** The candidate that won the rank. */
  candidate: MarketCandidate;
  /** Resolved 24h volume (USD) — the value used to rank survivors. */
  volume24h: number;
  /** Resolved open interest (USD). */
  openInterest: number;
}

/** Two-leg plan derived from a YES midpoint and the premium offset. */
export interface CycleLegs {
  /** Sell-limit price for the YES leg (= yesMidpoint + premium). */
  yesPrice: number;
  /** Sell-limit price for the NO leg  (= (1 − yesMidpoint) + premium). */
  noPrice: number;
  /** Size of each leg in outcome-token units (1 USDC = 1 minted pair). */
  size: number;
}

function volumeOf(c: MarketCandidate): number {
  return c.volume_24h ?? c.volume24h ?? 0;
}

function openInterestOf(c: MarketCandidate): number {
  return c.open_interest ?? c.openInterest ?? 0;
}

/**
 * Filter candidates by MINT-01 thresholds and rank by 24h volume.
 *
 * A candidate qualifies when ALL of the following hold:
 *   - `volume_24h           ≥ config.minVolume24h`
 *   - `open_interest        ≥ config.minOpenInterest`
 *   - `timeToCloseMs        ≥ config.minTimeToCloseMs`
 *   - `midpoint`             is in (0, 1)  — degenerate prices reject
 *   - `yesTokenId` and `noTokenId` are both present (CLOB-shaped strings)
 *
 * Returns the highest-volume survivor, or `null` if no candidate passes.
 */
export function selectMarket(
  candidates: MarketCandidate[],
  config: Mint01Config,
): MarketChoice | null {
  let best: MarketChoice | null = null;
  for (const candidate of candidates) {
    const volume24h = volumeOf(candidate);
    const openInterest = openInterestOf(candidate);
    if (volume24h < config.minVolume24h) continue;
    if (openInterest < config.minOpenInterest) continue;
    if (candidate.timeToCloseMs < config.minTimeToCloseMs) continue;
    if (candidate.midpoint <= 0 || candidate.midpoint >= 1) continue;
    if (!candidate.yesTokenId || !candidate.noTokenId) continue;

    if (best === null || volume24h > best.volume24h) {
      best = { candidate, volume24h, openInterest };
    }
  }
  return best;
}

/**
 * Plan the two sell legs for a MINT-01 cycle.
 *
 * `yesMidpoint` is the YES outcome midpoint price in (0, 1). The NO midpoint
 * is the binary complement, `1 − yesMidpoint`. Both legs are sold at their
 * respective midpoint + `premiumOffset` (in dollars).
 *
 * Size is the number of outcome-token units to sell on each leg. Because
 * `splitPosition($cycleCapital)` mints `cycleCapital` matched YES + NO pairs
 * (each pair backed by $1 USDC), the leg size equals `cycleCapital`.
 *
 * Throws when `yesMidpoint` is outside (0, 1) or when the premium would
 * push either leg price above $1 (an unfillable above-cap quote).
 */
export function planLegs(
  yesMidpoint: number,
  config: Mint01Config,
): CycleLegs {
  if (yesMidpoint <= 0 || yesMidpoint >= 1) {
    throw new Error(
      `planLegs: yesMidpoint ${yesMidpoint} must be in (0, 1).`,
    );
  }
  const yesPrice = yesMidpoint + config.premiumOffset;
  const noPrice = 1 - yesMidpoint + config.premiumOffset;
  if (yesPrice >= 1 || noPrice >= 1) {
    throw new Error(
      `planLegs: leg price >= 1 (yes=${yesPrice}, no=${noPrice}); ` +
        `midpoint ${yesMidpoint} too close to 0 or 1 for premium ` +
        `${config.premiumOffset}.`,
    );
  }
  return { yesPrice, noPrice, size: config.cycleCapital };
}

/**
 * Decide whether the cycle should exit on a stop-loss trigger.
 *
 * Returns `true` when the YES midpoint has drifted strictly more than
 * `config.stopLossDrift` dollars from the entry midpoint in either
 * direction. Caller is responsible for cancelling both legs and unwinding
 * via resolution.
 */
export function shouldStopLoss(
  entryMidpoint: number,
  currentMidpoint: number,
  config: Mint01Config,
): boolean {
  return Math.abs(currentMidpoint - entryMidpoint) > config.stopLossDrift;
}
