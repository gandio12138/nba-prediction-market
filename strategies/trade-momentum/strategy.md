# Strategy Design Specification: TRADE-02 Momentum Trading

**ID:** TRADE-02
**Archetype:** Directional momentum
**Platform:** Polymarket (CLOB)
**Risk:** Medium
**Complexity:** Medium

---

## 1. Edge Detection

**Thesis:** In prediction markets, low-probability outcomes that begin
trending upward on rising volume often continue toward consensus pricing
before resolution. Buying a YES contract while its implied probability is
in the `[0.10, 0.30]` band and price is rising fast on confirming volume
captures this drift toward a target exit near `0.50`.

**Why this edge exists:**
- Retail flow is slow to reprice markets once new information arrives
- Low-probability outcomes have thin order books, so early buyers see
  meaningful price impact as interest builds
- Volume spikes and open-interest expansion confirm the move is flow-led
  (not a single wallet painting the tape)

**Edge formula:**
```
grossEdge = exitTargetPrice - entryPrice   // e.g. 0.50 - 0.22 = 0.28
netReturn = (grossEdge - fees - gas - slippage) / entryPrice
```

Gross edge must clear the hurdle `hurdleRateGross` (5%).

---

## 2. Signal Generation

**Input:** Per-market time series maintained by the scan layer (rolling
history capped at 50 periods).

**Per-period indicators:**
1. `deltaPrice` — change in mid-price vs. prior period
2. `volumePercentile` — current period volume's rank in rolling window
   (N=20), linear interpolation
3. `rsi` — Wilder's smoothed RSI (window 14)
4. `macd` — EMA(12) − EMA(26), with signal EMA(9); crossover flag set
   when MACD crosses above signal this period
5. `oiTrend` — `"rising" | "flat" | "falling"` from open-interest series

**Confluence gate (≥2 of 4):**
- (a) `deltaPrice > 0.08` AND `volume > p80`
- (b) `RSI > 60` AND RSI rising
- (c) MACD crosses above signal this period
- (d) current volume > 2 × avg(last 10 periods)

**Entry gate:**
- Price ∈ `[0.10, 0.30]` — below-band is illiquid, above-band gives too
  little upside to the `0.50` target
- Gross edge `>= 0.05` after fees, gas, and slippage

**Signal function is pure:** `(snapshot, history, config) →
{ viable, confluenceScore, reason, size? }`. Fully testable with
hand-computed reference series.

---

## 3. Risk Management

**Position sizing:** Fractional Kelly (0.30 × full-Kelly), capped by
per-position and concurrent exposure limits.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 0.30 | Fractional Kelly multiplier |
| `maxExposure` | 0.10 | Max 10% of bankroll per position |
| `maxConcurrent` | 3 | Max 3 open positions (30% total exposure) |
| `bankroll` | $10,000 | Total available capital |

**Sizing formula:**
```
kellyRaw = edge / variance                 // full-Kelly estimate
kellySized = kellyRaw * kellyFraction
allocation = min(kellySized, maxExposure) * bankroll
numContracts = allocation / entryPrice
```

**Pre-trade checks (in order):**
1. **Manipulation guards** — reject if:
   - `topWalletShare > 0.80` (single wallet dominates volume)
   - price rising but `oiTrend === "falling"` (price without flow = paint)
   - `timeToClose < 7d` (insufficient runway to reach target)
   - **hard stop:** never operate with `timeToClose < 24h`
2. **Concurrent exposure** — reject if `openPositions >= maxConcurrent`
3. **Kelly sizing** — reduce size; reject if Kelly rounds to zero

---

## 4. Execution

**Scanner-only template.** No order submission. All signals are emitted
via `runner.ts` as JSONL dry-run entries. Operators review output to
decide whether to route to a live executor.

**Scan layer:**
1. Poll markets in the configured category (or unfiltered if none)
2. Maintain a per-market rolling history (capped at 50 periods). New
   periods append; oldest evict.
3. Compute indicators for the latest snapshot using the full window
4. Drop signals older than `signalTtlMs` (default 120s)

**Configuration (see `config.ts`):**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 0.30 | Fractional Kelly multiplier |
| `maxExposure` | 0.10 | Max bankroll share per position |
| `maxConcurrent` | 3 | Max open positions |
| `hurdleRateGross` | 0.05 | Min gross edge (5%) |
| `feeRate` | 0.02 | Platform fee (2%) |
| `gasCost` | 0.02 | Flat gas cost per signal (USD) |
| `slippage` | 0.005 | Assumed slippage (0.5%) |
| `entryMinPrice` | 0.10 | Lower bound of entry band |
| `entryMaxPrice` | 0.30 | Upper bound of entry band |
| `exitTargetPrice` | 0.50 | Target exit price |
| `deltaPriceThreshold` | 0.08 | Minimum Δprice per period |
| `volPercentileThreshold` | 80 | Minimum volume percentile (p80) |
| `signalTtlMs` | 120000 | Signal time-to-live (2 min) |
| `minTimeToCloseHours` | 24 | Hard-stop floor for market close |
| `preferredTimeToCloseDays` | 14 | Preferred runway before close |
| `maxTopWalletShare` | 0.80 | Reject if any wallet exceeds this |
| `rsiWindow` | 14 | RSI smoothing window |
| `macdFast` | 12 | MACD fast EMA |
| `macdSlow` | 26 | MACD slow EMA |
| `macdSignalPeriod` | 9 | MACD signal EMA |
| `volumeWindow` | 20 | Rolling volume percentile window |
| `historyCap` | 50 | Max periods retained per market |

---

## 5. Monitoring

**Structured logging:** Every pipeline decision is emitted as a JSONL
entry via `runner.ts`. In dry-run mode (default), the full pipeline runs
and decisions are logged without capital at risk.

**Log entry types:**
- `signal` — momentum candidate detected (price, Δprice, RSI, MACD,
  confluence score)
- `risk_check` — risk decision with reason (`manipulation_topWallet`,
  `manipulation_oiFalling`, `timeToClose`, `concurrent_limit`, `kelly_zero`)
- `reject` — confluence or entry-band gate failed
- `expired` — signal TTL elapsed before emit

**Signal TTL:** 120s. Momentum trades are slower than arb edges but still
degrade as the market repriceses; stale signals from prior scan cycles
are dropped.

**Manipulation monitoring:** The top-wallet-share check requires an
adapter field (`topWalletShare`) that is stubbed until the data adapter
exposes it. Until then, scanner output flags markets where the field is
missing so operators can validate externally.
