# Strategy Design Specification: ARB-03 NegRisk Multi-condition Buy

**ID:** ARB-03
**Archetype:** Multi-leg arbitrage
**Platform:** Polymarket (NegRisk markets, CLOB)
**Risk:** Low
**Complexity:** Medium

---

## 1. Edge Detection

**Thesis:** A NegRisk market with N mutually-exclusive outcomes resolves
to exactly $1.00 across all legs combined. If the sum of YES best-bid
prices across all N legs is less than $1.00, buying YES on every leg
locks in a guaranteed payout at resolution regardless of which outcome
wins.

**Why this edge exists:**
- Each leg is priced independently by market makers
- NegRisk markets often have 3-10+ mutually-exclusive outcomes,
  increasing the surface area for mispricing
- Low-liquidity tail outcomes (e.g. "Player X wins MVP" with <1% odds)
  are frequently sold too cheap by participants wanting to clear books
- Edge is mechanical and self-verifying — no prediction required

**Edge formula:**
```
sum    = Σ YES_bid_i          over i ∈ legs
fees   = feeRate × sum
gas    = gasPerLeg × N
netEdge = (1.00 − sum) − fees − gas
```

If `netEdge / sum ≥ hurdleRate`, a multi-leg arbitrage opportunity
exists.

---

## 2. Signal Generation

**Input:** Pre-fetched NegRisk `MarketData` (one per NegRisk market,
carrying an array of legs of length ≥ 2) from the scan layer.

**Pipeline:**
1. **NegRisk filter** — skip markets where `isNegRisk === false`
2. **Leg count** — require `legs.length >= 2`
3. **Edge detection** — `sum(YES_bid_i) < 1.00`
4. **Fee + gas deduction** — `fees = sum × feeRate`, `gas = gasPerLeg × N`
5. **Hurdle rate** — `(netEdge / sum) >= hurdleRate` (default 3%)
6. **Liquidity bottleneck** — `min(liquidity_i) >= minLegLiquidity`
7. **Per-leg price cap** — reject if any leg has `price > maxLegPriceWithLowLiq`
   with `liquidity < lowLiqThreshold`
8. **Confluence gate** — require ≥3 of 4 criteria pass (sum<0.97, min-liq,
   VWAP confirm, KL divergence). VWAP and KL are stubbed in this scanner
   phase with deterministic placeholders and `TODO(confluence)` markers.
9. **Emit** — one `buy_yes` `TradeSignal` per leg, all sharing the same
   `metadata.signalId` so downstream execution knows they are an atomic
   N-leg bundle.

**Signal function is pure:** takes `(MarketData, NegRiskBuyConfig)`,
returns `TradeSignal[]`. No side effects, no API calls. Fully testable
with hardcoded fixtures.

```
evaluateNegRiskOpportunity(market, config) -> TradeSignal[]
```

---

## 3. Risk Management

**Position sizing:** The weakest leg (minimum liquidity) caps the total
bundle size. Exposure is measured across all legs combined, not per-leg.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 0.15 | Fractional Kelly — more conservative than ARB-01 |
| `maxExposure` | 0.05 | Max 5% of bankroll across all legs combined |
| `bankroll` | $10,000 | Total available capital |
| `minLegLiquidity` | $300 | Reject bundle if any leg below this |
| `maxLegPriceWithLowLiq` | 0.30 | Price ceiling when leg liquidity is thin |
| `lowLiqThreshold` | $100 | Legs below this must be priced ≤ `maxLegPriceWithLowLiq` |
| `maxConsecutiveLosses` | 3 | Circuit breaker threshold |

**Sizing formula:**
```
bundleCost       = Σ YES_bid_i (= sum)
bankrollBudget   = bankroll × maxExposure
kellyBudget      = bankroll × (netEdge / sum) × kellyFraction
bundleBudget     = min(bankrollBudget, kellyBudget)
weakestLegSize   = min(liquidity_i)
numBundles       = min(bundleBudget, weakestLegSize × bundleCost) / bundleCost
```

**Pre-trade checks (in order):**
1. **Circuit breaker** — halt after too many consecutive losses
2. **Leg liquidity bottleneck** — reject if any leg below `minLegLiquidity`
3. **Low-liquidity price cap** — reject if any leg `price > maxLegPriceWithLowLiq`
   while `liquidity < lowLiqThreshold`
4. **Bundle exposure** — reject if bundle total > `maxExposure × bankroll`
5. **Kelly sizing** — shrink to Kelly-optimal; reject if Kelly rounds to zero

Risk checks run identically in dry-run and live mode — the scanner logs
whether each signal would have passed gating.

---

## 4. Execution

**Order mechanics (out of scope for this scanner-only template):**
- Each signal bundle emits N `buy_yes` orders (one per leg)
- All legs must execute to capture the arb (partial fills = directional exposure)
- Live mode would submit via `Promise.all` with a strict TTL — stale
  bundles are dropped

**Current template is scanner-only (dry-run):**
- Pipeline runs through scan → signal → risk → entry (log only)
- `entry.ts` writes a structured `signal` log entry via the shared
  execution-log module
- No wallet auth required, no order submission

**Scan layer:**
1. `searchMarkets(config.category)` — filter to `isNegRisk === true`
2. For each market: fetch the leg array (prices + liquidity per leg)
3. Return `NegRiskMarketData[]` for signal detection

**Configuration:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `category` | `"NBA Champion"` | Required category filter |
| `feeRate` | 0.02 | Platform fee per trade (2%) |
| `gasPerLeg` | 0.05 | Flat gas cost per leg in USD |
| `hurdleRate` | 0.03 | Min net return (3%) — higher than ARB-01 for multi-leg risk |
| `signalTtlMs` | 15000 | Signal TTL (15s — multi-leg needs more buffer than ARB-01's 5s) |
| `minLegLiquidity` | 300 | Minimum per-leg liquidity in USD |
| `maxLegPriceWithLowLiq` | 0.30 | Price cap for legs below `lowLiqThreshold` |
| `lowLiqThreshold` | 100 | Liquidity level that triggers the low-liq price cap |
| `sumThreshold` | 0.97 | Confluence: flag "strong" when sum < 0.97 |

---

## 5. Monitoring

**Structured logging:** Every pipeline decision is recorded as a JSONL
execution log entry via the shared `execution-log.ts` module.

**Log entry types:**
- `signal` — signal bundle detected (N legs, combined metadata)
- `risk_check` — per-bundle risk decision (approved/rejected, reason)
- `error` — pipeline error (error message, stage)

**Dry-run mode:** Full pipeline runs with logging, but no order
submission. Operators see which bundles would execute and which would
be risk-rejected, without capital at risk.

**Circuit breaker:** After `maxConsecutiveLosses` consecutive losing
bundles, all new signals are rejected until a winning bundle resets
the counter.

**Signal TTL:** Bundles expire after `signalTtlMs` (default 15s).
Multi-leg bundles need a longer TTL than binary arbs because all legs
must execute together.
