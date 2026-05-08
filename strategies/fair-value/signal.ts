/**
 * IA-03 Fair Value Probability Model — Signal Detection
 *
 * Pure, statistical fair-value scanner. Given a per-market snapshot and
 * a pluggable `ProbabilityModel`, compute a fair probability and emit
 * divergence candidates when |fair − market| clears the configured
 * threshold. Inputs are numeric only — purely statistical.
 */

import type { TradeSignal } from "../../types/TradeSignal.js";
import type { FairValueConfig } from "./config.js";

/** Numeric-only context passed to the probability model. */
export interface MarketContext {
  /** Polymarket condition ID. */
  conditionId: string;
  /** Current YES mid-price as a probability (0.0–1.0). */
  marketPrice: number;
  /** 24h USD volume. */
  volume24h: number;
  /** Open interest in USD. */
  openInterest: number;
  /** Milliseconds until market close. */
  timeToCloseMs: number;
  /** Volume buckets spanning the last 48h (oldest → newest). */
  volumeHistory48h: number[];
}

/** Snapshot consumed by the signal layer. Extends `MarketContext` with text. */
export interface MarketSnapshot extends MarketContext {
  /** Human-readable market question. */
  question: string;
}

/** Output of a probability model for a single market. */
export interface ModelOutput {
  /** Estimated fair probability (0.0–1.0). */
  fairValue: number;
  /** Source identifiers feeding the estimate (for confluence gating). */
  sources: string[];
  /** Model-reported confidence in the estimate (0.0–1.0). */
  confidence: number;
}

/** Pluggable statistical model interface. */
export interface ProbabilityModel {
  computeFairValue(ctx: MarketContext): ModelOutput;
}

/** Divergence tier classification. */
export type DivergenceTier = "full" | "half" | "none";

/**
 * Classify a divergence magnitude into a sizing tier.
 *
 * `|fair − market| ≥ fullTierDivergencePp` → full Kelly,
 * `[minDivergencePp, fullTierDivergencePp)` → half Kelly,
 * below `minDivergencePp` → no signal.
 */
export function divergenceTier(
  absDivergence: number,
  config: FairValueConfig,
): DivergenceTier {
  if (absDivergence >= config.fullTierDivergencePp) return "full";
  if (absDivergence >= config.minDivergencePp) return "half";
  return "none";
}

/** Arguments for `kellyFraction`. */
export interface KellyArgs {
  fair: number;
  market: number;
  haircut: number;
  sizingMultiplier: number;
}

/**
 * Closed-form Kelly bet fraction with haircut and tier multiplier.
 *
 * `fair > market`  → f* = (fair − market) / (1 − market),
 * `fair < market`  → f* = (market − fair) / market (mirror / buy-NO),
 * `fair = market`  → 0 (no edge).
 *
 * Returned value is `f* × haircut × sizingMultiplier`.
 */
export function kellyFraction(args: KellyArgs): number {
  const { fair, market, haircut, sizingMultiplier } = args;
  if (fair === market) return 0;
  const raw = fair > market
    ? (fair - market) / (1 - market)
    : (market - fair) / market;
  return raw * haircut * sizingMultiplier;
}

/** Result of evaluating one snapshot against the fair-value rules. */
export interface FairValueEvaluation {
  /** True if all gates passed and a signal was emitted. */
  viable: boolean;
  /** Divergence tier applied (before any rejection). */
  tier: DivergenceTier;
  /** Kelly sizing multiplier for this tier (1.0 full, 0.5 half, 0 none). */
  sizingMultiplier: number;
  /** Signed divergence (fair − market). */
  divergence: number;
  /** Absolute divergence magnitude. */
  absDivergence: number;
  /** Number of confluence criteria satisfied (0–3). */
  confluenceCount: number;
  /** Fair value returned by the model. */
  fairValue: number;
  /** Market price used as the reference. */
  marketPrice: number;
  /** Sources feeding the fair-value estimate. */
  sources: string[];
  /** Model confidence (0.0–1.0). */
  confidence: number;
  /** Human-readable rejection reason (set when `viable` is false). */
  reason?: string;
  /** Emitted trade signal (set when `viable` is true). */
  signal?: TradeSignal;
}

function sizingMultiplierFor(tier: DivergenceTier): number {
  if (tier === "full") return 1.0;
  if (tier === "half") return 0.5;
  return 0;
}

/** True when total volume in the newer half of the 48h window exceeds the older half. */
function isVolumeRising(history: number[]): boolean {
  if (history.length < 2) return false;
  const mid = Math.floor(history.length / 2);
  let older = 0;
  let newer = 0;
  for (let i = 0; i < mid; i += 1) older += history[i] ?? 0;
  for (let i = mid; i < history.length; i += 1) newer += history[i] ?? 0;
  return newer > older;
}

/**
 * Evaluate a market snapshot for a fair-value divergence opportunity.
 *
 * Gates (in order): time-to-close floor → liquidity → tier → confluence.
 * Returns a `FairValueEvaluation` describing the outcome; `signal` is
 * populated only when every gate passes.
 */
export function evaluateFairValueOpportunity(
  snapshot: MarketSnapshot,
  model: ProbabilityModel,
  config: FairValueConfig,
): FairValueEvaluation {
  const modelOutput = model.computeFairValue({
    conditionId: snapshot.conditionId,
    marketPrice: snapshot.marketPrice,
    volume24h: snapshot.volume24h,
    openInterest: snapshot.openInterest,
    timeToCloseMs: snapshot.timeToCloseMs,
    volumeHistory48h: snapshot.volumeHistory48h,
  });
  const { fairValue, sources, confidence } = modelOutput;
  const divergence = fairValue - snapshot.marketPrice;
  const absDivergence = Math.abs(divergence);
  const tier = divergenceTier(absDivergence, config);
  const sizingMultiplier = sizingMultiplierFor(tier);

  const divergencePass = absDivergence >= config.minDivergencePp;
  const sourcesPass = sources.length >= config.minSources;
  const volumeRising = isVolumeRising(snapshot.volumeHistory48h);
  const confluenceCount =
    (divergencePass ? 1 : 0) + (sourcesPass ? 1 : 0) + (volumeRising ? 1 : 0);

  const base = {
    tier,
    sizingMultiplier,
    divergence,
    absDivergence,
    confluenceCount,
    fairValue,
    marketPrice: snapshot.marketPrice,
    sources,
    confidence,
  };

  const minCloseMs = config.minTimeToCloseDays * 24 * 60 * 60 * 1000;
  if (snapshot.timeToCloseMs < minCloseMs) {
    return {
      ...base,
      viable: false,
      reason:
        `Time-to-close ${snapshot.timeToCloseMs}ms below floor of ` +
        `${config.minTimeToCloseDays}d`,
    };
  }

  if (snapshot.volume24h <= config.minVolume24h) {
    return {
      ...base,
      viable: false,
      reason:
        `Liquidity: volume_24h $${snapshot.volume24h} not above ` +
        `$${config.minVolume24h}`,
    };
  }
  if (snapshot.openInterest <= config.minOpenInterest) {
    return {
      ...base,
      viable: false,
      reason:
        `Liquidity: openInterest $${snapshot.openInterest} not above ` +
        `$${config.minOpenInterest}`,
    };
  }

  if (tier === "none") {
    return {
      ...base,
      viable: false,
      reason:
        `Divergence ${absDivergence.toFixed(4)} below tier threshold ` +
        `${config.minDivergencePp}`,
    };
  }

  if (confluenceCount < 2) {
    return {
      ...base,
      viable: false,
      reason:
        `Confluence: ${confluenceCount} of 3 criteria satisfied ` +
        `(need ≥ 2)`,
    };
  }

  const direction: TradeSignal["direction"] =
    divergence > 0 ? "buy_yes" : "buy_no";
  const size =
    kellyFraction({
      fair: fairValue,
      market: snapshot.marketPrice,
      haircut: config.kellyHaircut,
      sizingMultiplier,
    }) * config.bankroll;

  const signal: TradeSignal = {
    automation_id: "fair-value-v1",
    timestamp: new Date(),
    market: {
      platform: "polymarket",
      market_id: snapshot.conditionId,
      question: snapshot.question,
    },
    direction,
    size,
    confidence,
    urgency: "normal",
    metadata: {
      fairValue,
      marketPrice: snapshot.marketPrice,
      divergence,
      tier,
      sizingMultiplier,
      sources,
      confidence,
      timeToCloseMs: snapshot.timeToCloseMs,
      volume24h: snapshot.volume24h,
      openInterest: snapshot.openInterest,
      limitOnly: true,
    },
  };

  return { ...base, viable: true, signal };
}

/** Fixture entry for `StaticFairValueModel`. */
export interface StaticFairValueFixture {
  fairValue: number;
  sources: string[];
  confidence: number;
}

/**
 * Default, fixture-driven probability model.
 *
 * Returns the configured fixture for a known `conditionId`. For unknown
 * ids, returns a neutral result (`fairValue = marketPrice`, no sources)
 * so downstream gates reject without emitting a signal.
 */
export class StaticFairValueModel implements ProbabilityModel {
  private readonly fixtures: Record<string, StaticFairValueFixture>;

  constructor(fixtures: Record<string, StaticFairValueFixture>) {
    this.fixtures = fixtures;
  }

  computeFairValue(ctx: MarketContext): ModelOutput {
    const fixture = this.fixtures[ctx.conditionId];
    if (fixture) {
      return {
        fairValue: fixture.fairValue,
        sources: fixture.sources,
        confidence: fixture.confidence,
      };
    }
    return { fairValue: ctx.marketPrice, sources: [], confidence: 0 };
  }
}
