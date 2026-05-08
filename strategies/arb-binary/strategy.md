# Strategy Design Specification: ARB-01 Binary Arb Buy

**ID:** ARB-01
**Archetype:** Pure arbitrage
**Platform:** Polymarket (CLOB)
**Risk:** Very Low
**Complexity:** Low

---

## 1. Edge Detection

**Thesis:** On Polymarket binary markets, every condition resolves to
exactly $1.00 across YES and NO outcomes. If the best ask for YES plus
the best ask for NO is less than $1.00, buying both sides locks in a
guaranteed profit at resolution regardless of outcome.

**Why this edge exists:**
- Market makers and retail traders price each side independently
- Temporary imbalances appear when one side moves before the other
- Low-liquidity markets sustain wider spreads longer
- The edge is mechanical (no prediction required) and self-verifying

**Edge formula:**
```
cost = YES_ask + NO_ask
grossEdge = 1.00 - cost
```

If `grossEdge > 0`, an arbitrage opportunity exists.

---

## 2. Signal Generation

**Input:** Pre-fetched `MarketData[]` from the scan layer (category-filtered).

**Pipeline:**
1. **Category filter** — skip markets outside the configured category
2. **Slippage abort** — skip if `estimatedSlippage >= slippageAbort` (default 0.3%)
3. **Edge detection** — `YES_ask + NO_ask` must be `< $1.00`
4. **Fee deduction** — `totalFees = cost * feeRate + gasCost`
5. **Net return** — `netReturn = (grossEdge - totalFees) / cost`
6. **Hurdle rate** — `netReturn` must be `>= hurdleRate` (default 1.5%)
7. **Emit** — `buy_yes` + `buy_no` TradeSignal pair with Kelly-sized positions

**Signal function is pure:** takes `(MarketData[], ArbBinaryConfig)`,
returns `TradeSignal[]`. No side effects, no API calls. Fully testable
with hardcoded data.

```
detectSignals(markets, config) -> TradeSignal[]
```

---

## 3. Risk Management

**Position sizing:** Quarter-Kelly, capped at max bankroll exposure.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 0.25 | Quarter-Kelly for conservative sizing |
| `maxExposure` | 0.08 | Max 8% of bankroll per position |
| `bankroll` | $10,000 | Total available capital |
| `maxConsecutiveLosses` | 3 | Circuit breaker threshold |

**Sizing formula:**
```
rawSize = bankroll * netReturn * kellyFraction
maxSize = bankroll * maxExposure
numContracts = min(rawSize, maxSize) / cost
```

**Pre-trade checks (in order):**
1. **Circuit breaker** — reject if consecutive losses >= threshold
2. **Exposure check** — reject if position size > `maxExposure * bankroll`
3. **Kelly sizing** — reduce size to Kelly-optimal; reject if Kelly rounds to zero

Risk checks run in both dry-run and live mode. Scanner output shows
whether each signal would pass risk gating.

---

## 4. Execution

**Order mechanics:**
- Each signal emits a `buy_yes` + `buy_no` pair
- Both orders must execute to capture the arb (one-sided = directional bet)
- In dry-run mode: log both signals, skip order submission
- In live mode: submit both orders via `Promise.all` for near-simultaneous execution
- Urgency: `immediate` (arb edges are transient)

**Run modes (`entry.ts`):**

| Flag | Behaviour |
|------|-----------|
| _(none)_ | Dry-run. Full pipeline runs; orders are NOT submitted. |
| `--dry-run` | Same as default — explicit dry-run. |
| `--live` | Live execution. Real CLOB orders are placed via `createLiveExecutor`. |

`--live` is the only path that places orders. A typo, a missing flag, or
any unrelated argv entry leaves the strategy in dry-run.

**Live execution prerequisites:**
- A funded Polymarket wallet configured at `.canon/wallet.env`
  (loaded via `wallet-store.ts` → `FileWalletStore`).
- USDC balance on Polygon for the orders being placed.
- USDC allowance to the CTFExchange. The live executor manages this
  idempotently: `getAllowance()` is consulted lazily; `approve()` is
  only sent when the cached allowance is below `100k USDC`, and tops
  the allowance up to `1M USDC` (6-decimal raw values
  `100_000_000_000n` / `1_000_000_000_000n`).
- Submitted order IDs are tracked in-memory and cancellable through
  the same executor (`executor.cancel(orderId)`), enabling MINT-05
  cancel/replace flows to reuse this layer.

**Safety notes:**
- Default is dry-run — the runner never submits without `--live`.
- The risk-checker circuit breaker trips after `maxConsecutiveLosses=3`
  and rejects every subsequent signal until a winning trade resets
  the counter. This is verified by
  `strategies/arb-binary/__tests__/entry.test.ts`.
- An optional integration test (gated behind `CANON_LIVE_TEST=1`)
  places a single tiny order on a low-liquidity market; CI never runs it.

**Scan layer:**
1. `searchMarkets(config.category)` — fetch binary markets matching category
2. `fetchOrderBook(yesTokenId)` + `fetchOrderBook(noTokenId)` — per market
3. Extract best (lowest) ask price from each side
4. Estimate slippage as `max((yesAsk - yesBid) / yesAsk, (noAsk - noBid) / noAsk)`
5. Return `MarketData[]` for signal detection

**Configuration:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `category` | `"NBA"` | Required category filter (no scan-all) |
| `feeRate` | 0.02 | Platform fee per trade (2%) |
| `gasCost` | $0.02 | Flat gas cost per signal |
| `hurdleRate` | 0.015 | Min net return (1.5%) |
| `slippageAbort` | 0.003 | Max slippage before abort (0.3%) |
| `signalTtlMs` | 5000 | Signal time-to-live (5s) |

---

## 5. Monitoring

**Structured logging:** Every pipeline decision is recorded as a JSONL
execution log entry via the shared `execution-log.ts` module.

**Log entry types:**
- `signal` — signal detected (direction, size, confidence)
- `risk_check` — risk decision (approved/rejected, reason, modified size)
- `order_submit` — order submitted (order ID, status)
- `error` — pipeline error (error message, stage)

**Dry-run mode:** Full pipeline runs (scan, signal, risk) with logging,
but order submission is skipped. Operators see exactly which trades would
execute and which would be risk-rejected, without capital at risk.

**Circuit breaker:** After `maxConsecutiveLosses` consecutive losing
trades, all new signals are rejected until the breaker resets (via a
winning trade). This prevents compounding losses from adverse market
conditions or systematic pricing errors.

**Signal TTL:** Signals expire after `signalTtlMs` (default 5s).
Stale signals from a previous scan cycle are not executed — arb edges
are transient and prices move.
