/**
 * MarketVenueOnboard — registry hook for venue onboarding adapters.
 *
 * Each supported venue (Polymarket, Kalshi, ...) exports a value implementing
 * this interface. The CLI driver looks up an adapter from a registry by
 * `venue` and calls `build(privateKey)` to obtain an `OnboardClient`.
 */

import type { OnboardClient } from "./OnboardClient.ts";

export interface MarketVenueOnboard {
  readonly venue: "polymarket" | "kalshi" | string;
  readonly chainId: number;
  build(privateKey: string): OnboardClient;
}
