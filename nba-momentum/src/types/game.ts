/** A team's championship odds comparison across venues. */
export interface TeamComparison {
  team: string;
  /** Average implied probability from sportsbook outrights. */
  sportsbookProb: number;
  /** Polymarket YES price for this team's championship market. */
  polymarketPrice: number;
  /** sportsbookProb - polymarketPrice (positive = sportsbook higher). */
  delta: number;
  /** Number of sportsbook sources contributing to the average. */
  sources: number;
}
