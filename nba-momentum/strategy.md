# Strategy Design Specification: NBA Championship Futures Scanner

**Archetype:** Cross-venue arbitrage
**Platforms:** The Odds API (sportsbooks) + Polymarket
**Category:** Sports — NBA Championship

---

## Target Markets

| Field | Value |
|-------|-------|
| Sportsbook market | `basketball_nba_championship_winner` (outrights) |
| Polymarket market | "Will [Team] win the 2026 NBA Finals?" |
| Resolution | End of NBA Finals |
| Teams | All 30 NBA teams |
| Season | 2025-2026 |

Both sportsbooks and Polymarket offer futures on which team wins the NBA
Championship. Sportsbooks publish decimal odds per team; Polymarket lists
individual binary markets per team with a YES/NO price.

---

## Edge Analysis

**Thesis:** Sportsbook championship odds and Polymarket futures prices
occasionally diverge because they serve different user bases and update at
different speeds. When the implied probability from sportsbook consensus
differs from the Polymarket YES price by more than a threshold, a
mispricing exists.

**Why this market:**
- Same underlying event on both platforms (who wins the NBA title)
- Sportsbooks aggregate sharp money from professional bettors
- Polymarket prices reflect retail prediction market participants
- 30 teams = 30 comparison points per scan cycle
- Prices change on trades, injuries, playoff seeding shifts

---

## Signal Logic

**For each team:**
1. Compute average implied probability from sportsbook outrights:
   `impliedProb = average(1 / decimalOdds)` across all bookmakers
2. Match team to Polymarket market by name (fuzzy match with aliases)
3. Compare: `delta = impliedProb - polymarketYesPrice`
4. If `|delta| >= mispricingThreshold`: flag as signal

**Direction:**
- `delta > 0` → sportsbooks price the team higher → Polymarket YES is cheap
- `delta < 0` → Polymarket prices the team higher → sportsbook odds are longer

```
function checkSignal(team, sportsbookProb, polymarketPrice, config):
  delta = sportsbookProb - polymarketPrice
  if abs(delta) < config.mispricingThreshold: return NO_SIGNAL

  direction = "sportsbook higher" if delta > 0 else "Polymarket higher"
  return SIGNAL(team, delta, direction)
```

---

## Configuration

| Parameter | Value | Description |
|-----------|-------|-------------|
| `mispricingThreshold` | 0.005 (0.5%) | Min delta to flag signal |
| `sportKey` | `basketball_nba_championship_winner` | The Odds API sport key |
| `searchQuery` | `NBA Finals` | Polymarket search query |
| `pollIntervalMs` | 30000 | Scan cycle interval |

---

## Risk Parameters

This is a scanner, not a trader. It runs in dry-run mode only — no
orders are placed. Risk parameters apply to the signal detection logic:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Min bookmaker sources | 2 | Require consensus, not single-source noise |
| Max delta percent | 0.50 (50%) | Cap to filter erroneous data |
| Signal logging | Every signal to JSONL | Full audit trail |

---

## Data Requirements

| Data Point | Source | Endpoint |
|------------|--------|----------|
| Championship outright odds | The Odds API | `/v4/sports/basketball_nba_championship_winner/odds` |
| NBA futures markets | Polymarket (pmxtjs) | `searchMarkets("NBA Finals")` |

---

## Implementation Notes

- Runner is bootstrapped: polling loop, stdout protocol, JSONL logger, SIGINT handler
- Runner imports config from `src/config/strategy.ts` for thresholds
- Team matching uses fuzzy normalization + NBA alias table
- Polymarket outcomes use team-name labels, not "Yes"/"No"
- Sportsbook outrights use the `outrights` market key, not `h2h`
