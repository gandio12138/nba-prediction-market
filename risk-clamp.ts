/**
 * Shared risk-clamp primitive for `RiskInterface.preTradeCheck` impls.
 *
 * Each strategy computes its own caps (per-position, aggregate, live
 * capital, etc. — values vary by config field name and math), then
 * delegates the comparison-and-decision step to `clampToHeadroom`.
 * That keeps cap *intent* per-strategy while centralizing the rule
 * for "approve at min(...) unless below the fillable floor".
 */

import type { RiskDecision } from "./types/RiskInterface.js";

/** Default floor below which a clamped size is treated as unfillable. */
export const DEFAULT_MIN_FILLABLE_SIZE = 0.01;

/** A single named cap supplied to `clampToHeadroom`. */
export interface NamedCap {
  /** Operator-facing label used in rejection reasons (e.g. "live capital"). */
  name: string;
  /** Maximum size permitted by this cap, in USD. May be negative (over-cap). */
  value: number;
}

/** Optional knobs for `clampToHeadroom`. */
export interface ClampOptions {
  /**
   * Approved sizes strictly below this floor are rejected as not worth
   * filling. Defaults to `DEFAULT_MIN_FILLABLE_SIZE` ($0.01).
   */
  minFillable?: number;
}

/**
 * Reduce `requested` to the binding cap and return a `RiskDecision`.
 *
 * - Approves at `requested` when no cap binds tighter.
 * - Approves with `modified_size` when at least one cap is below `requested`.
 * - Rejects when the binding cap value is below `minFillable` (including
 *   negative values, which indicate the strategy is already over-exposed).
 *
 * Rejection reasons name every cap so operators can see which one bound
 * and which had headroom — useful when multiple caps converge near zero.
 */
export function clampToHeadroom(
  requested: number,
  caps: readonly NamedCap[],
  options: ClampOptions = {},
): RiskDecision {
  const minFillable = options.minFillable ?? DEFAULT_MIN_FILLABLE_SIZE;

  let approvedSize = requested;
  let binding: NamedCap | undefined;
  for (const cap of caps) {
    if (cap.value < approvedSize) {
      approvedSize = cap.value;
      binding = cap;
    }
  }

  if (approvedSize < minFillable) {
    const summary = caps
      .map((c) => `${c.name} $${c.value.toFixed(2)}`)
      .join(", ");
    const bindingName = binding?.name ?? "requested size";
    return {
      approved: false,
      rejection_reason:
        `No headroom (binding: ${bindingName}, requested`
        + ` $${requested.toFixed(2)}): ${summary}`,
    };
  }

  if (approvedSize >= requested) {
    return { approved: true };
  }
  return { approved: true, modified_size: approvedSize };
}
