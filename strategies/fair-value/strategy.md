# Strategy Design Specification: IA-03 Fair Value Probability Model

**ID:** IA-03
**Archetype:** Statistical fair-value divergence
**Platform:** Polymarket (CLOB)
**Risk:** Medium
**Complexity:** High

---

## 1. Edge Detection

**Thesis:** For many prediction-market contracts, an outcome's true
probability can be estimated from numeric signals (historical base
rates, structured market data, calibrated models) independently of its
current market price. Whenever a model's `fairValue` diverges from the
quoted `marketPrice` by at least `minDivergencePp` (5 probability
points), the market is mispriced relative to the model and a
directional position in the direction of the fair value captures the
expected reversion.

**Why this edge exists:**
- Retail flow overweights recent events and recency-biased narratives
- Thin mid-cap prediction markets under-react to slowly accumulating
  numeric evidence (pollster aggregates, league standings, counts)
- Model outputs from calibrated statistical sources mean-revert faster
  than sentiment-driven prices

**Edge formula:**
```
divergence = fairValue - marketPrice     // signed, in probability
abs = |divergence|                        // magnitude in pp
```

A signal fires when `abs >= minDivergencePp`. Direction is `YES` when
`divergence > 0` (model says higher than market), `NO` when
`divergence < 0`.

### Out of scope

- **No news ingestion, NLP, sentiment, or LLM calls.** The model
  interface accepts numeric inputs only. News-aware variants are
  separate strategies (IA-01).
- **No external HTTP fetches from the template.** The default
  `StaticFairValueModel` is fixture-driven; real models plug in via the
  `ProbabilityModel` interface and supply their own data layer.

---

## 2. Signal Generation

**Input:** Per-market numeric snapshot from the scan layer plus a
pluggable `ProbabilityModel`.

**Pipeline:**
1. **Liquidity gate** — reject if `volume_24h < minVolume24h` or
   `openInterest < minOpenInterest`
2. **Time-window gate** — reject if `timeToCloseDays < minTimeToCloseDays`
   (7d floor); score preference boost for `<= preferredTimeToCloseDays`
3. **Model call** — `model.computeFairValue(ctx) → { fairValue, sources, confidence }`
4. **Divergence tier** — see table below; `< minDivergencePp` → no signal
5. **Confluence gate (≥2 of 3)** —
   (a) `|divergence| >= minDivergencePp`
   (b) `sources.length >= minSources` (default 2)
   (c) `volume_24h` trending up across the last 48h
6. **Kelly sizing** — full or half tier; see §3
7. **Emit** — directional dry-run `TradeSignal` with `{ fairValue,
   marketPrice, divergence, tier, sizingMultiplier, sources,
   confidence }` metadata; limit-only intent recorded

Signal generation is pure: takes
`(MarketSnapshot, ProbabilityModel, FairValueConfig)`, returns
`TradeSignal | null`. No side effects.

### Divergence tiers

| `|divergence|` | Tier | Sizing multiplier |
|----------------|------|-------------------|
| `>= 0.08` (≥ 8pp) | `full` | 1.0 (full Kelly) |
| `0.05 – 0.08` (5–8pp) | `half` | 0.5 (half Kelly) |
| `< 0.05` (< 5pp) | `none` | — (no signal) |

`divergenceTier(delta)` returns one of `"full" | "half" | "none"`.

---

## 3. Risk Management

**Position sizing:** Fractional Kelly, capped at per-position bankroll
share and portfolio concurrency ceiling.

**Kelly formula:**
```
// model says YES probability higher than market (buy YES at `market`)
f_star = (fair - market) / (1 - market)

// model says YES probability lower (buy NO at `1 - market`)
f_star = (market - fair) / market        // mirror case

f_real = f_star * kellyHaircut * sizingMultiplier
```

`kellyHaircut` is the portfolio-level haircut (default 0.25). The
per-signal `sizingMultiplier` comes from the divergence tier
(`full`=1.0, `half`=0.5).

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyHaircut` | 0.25 | Quarter-Kelly portfolio haircut |
| `maxExposurePerPosition` | 0.10 | Max 10% of bankroll per position |
| `maxConcurrent` | 5 | Max open positions (≤50% total exposure) |
| `bankroll` | $10,000 | Total available capital |

**Pre-trade checks (in order):**
1. **Liquidity** — `volume_24h > $5,000`, `openInterest > $3,000`
2. **Time window** — `timeToClose >= 7d`
3. **Concurrency** — reject if `openPositions >= maxConcurrent`
4. **Per-position cap** — clamp `f_real * bankroll <= maxExposurePerPosition * bankroll`
5. **TTL** — reject signals older than `signalTtlMs` (24h)

All orders are recorded as **limit-only intent** in signal metadata.
No market orders — the template never widens the spread it is trying
to trade.

---

## 4. Execution

**Scanner-only template.** Execution is a dry-run emit via
`runner.ts`:

- Poll configured markets → build `MarketSnapshot`
- Invoke `ProbabilityModel.computeFairValue` per snapshot
- Apply liquidity / time / divergence / confluence gates
- Apply Kelly sizing and risk checks
- Emit signals as JSONL via the shared `runner.ts` runner

**Configuration:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `category` | `undefined` | Optional category filter |
| `minDivergencePp` | 0.05 | Divergence threshold (5pp) |
| `fullTierDivergencePp` | 0.08 | Full-Kelly tier threshold (8pp) |
| `minVolume24h` | $5,000 | Liquidity floor |
| `minOpenInterest` | $3,000 | Open-interest floor |
| `signalTtlMs` | 24h | Signal time-to-live |
| `minTimeToCloseDays` | 7 | Hard floor on market runway |
| `preferredTimeToCloseDays` | 30 | Preferred runway ceiling |
| `minSources` | 2 | Required model sources for confluence (b) |
| `kellyHaircut` | 0.25 | Fractional-Kelly multiplier |
| `maxExposurePerPosition` | 0.10 | Per-position bankroll cap |
| `maxConcurrent` | 5 | Max concurrent positions |
| `bankroll` | $10,000 | Total capital |

---

## 5. Model Plug-in Contract

The template ships the plumbing, not the edge. The `ProbabilityModel`
interface lets operators attach any numeric model:

```
interface ProbabilityModel {
  computeFairValue(ctx: MarketContext): {
    fairValue: number;     // [0, 1]
    sources: string[];     // named numeric sources used
    confidence: number;    // [0, 1]
  };
}
```

`MarketContext` carries only numeric fields (price history, volume,
open interest, resolution metadata). No text bodies, no headlines, no
transcripts. This is enforced by the type — additions that violate it
should be rejected in review.

The default `StaticFairValueModel` reads a fixture map keyed by
`conditionId` and returns a deterministic `{ fairValue, sources,
confidence }` — useful for tests and for bootstrapping real operators
before they wire a live numeric model.

---

## 6. Monitoring

**Structured logging:** Every pipeline decision is a JSONL log entry
via the shared `execution-log.ts` module.

**Log entry types:**
- `signal` — emitted candidate (tier, fair, market, divergence,
  sources, confidence, sizingMultiplier)
- `risk_check` — gate decision (approved/rejected, reason)
- `model_call` — model invocation summary (sources, confidence, latency)
- `error` — pipeline error (stage, message)

**Signal TTL:** Signals expire after `signalTtlMs` (24h). Fair-value
divergences are slower to decay than arb edges but still mean-revert —
stale signals are not re-emitted.

**Portfolio cap:** `maxConcurrent` (default 5) is enforced in-process
only. Persistence is a separate concern and lives outside this
template.
