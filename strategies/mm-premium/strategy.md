# Strategy Design Specification: MINT-04 Market Making Premium

**ID:** MINT-04
**Archetype:** Minting + paired market making
**Platform:** Polymarket (CLOB + CTF mint)
**Risk:** Low
**Complexity:** High
**Scope:** Scanner-only (dry-run). Execution (mint set + paired limit sells) is out of scope.

---

## 1. Edge Detection

**Thesis:** On Polymarket binary markets, a $1 complete set (1 YES + 1 NO)
can be minted via the CTF contract. If both legs are resold as limit sells
posted at `midpoint ± offset`, the operator captures the offset on each
leg when filled, earning a structural premium over buy-and-hold market
makers who post tighter quotes.

**Why this edge exists:**
- Mint cost is fixed at $1.00 per complete set; platform spread above $1
  represents an instantaneous premium.
- Liquid markets continuously fill both sides near the midpoint, so
  posted limit sells are captured within the signal TTL window.
- LP rebate programs credit a small flat amount per cycle on top of
  gross premium.
- The edge is mechanical (no prediction required); directional exposure
  is eliminated by holding both legs until filled.

**Gross premium per cycle:**

```
gross   = offset_c * 2 * contracts         // both legs
fees    = fee_rate * capital               // flat per $1,000
gas     = gas_cost                         // flat per cycle
lp      = lp_rebate * (capital / 1_000)    // flat per $1,000
net     = gross - fees - gas + lp
```

At defaults (`offset=$0.0075`, `capital=$1,000`): `bruto $15 − fees $1.70
− gas $0.05 + lp $0.275 = $13.575` — exposed as `projectedNetPerCycle()`.

---

## 2. Signal Generation

**Input:** Pre-fetched `MintPremiumSnapshot[]` from the scan layer.

**Pipeline:**

1. **Market filter** — drop markets below `volume24hThreshold`.
2. **Confluence check** — pass if ≥2 of 3 hold:
   - `volume_24h > 20_000`
   - `trade_count_1h ≥ 10`
   - `bid_ask_spread < 0.015`
3. **Offset selection** — by `volume_24h`:
   - `> $50,000` → `+1.0c` (aggressive)
   - `$10k–$50k` → `+0.75c` (default)
   - `< $10k` → emit downgrade advisory suggesting **MINT-02**; reject
     for MINT-04.
4. **Per-leg liquidity sanity** — if `trade_count_1h < 3`, emit a
   `low_activity` warning and downgrade offset to `+0.5c`.
5. **Net projection** — `projectedNetPerCycle()` returns USD for the
   selected offset bracket.
6. **Hurdle gate** — `net / capital ≥ hurdleRate` (default 1.33%).
   Reject below.
7. **Emit** — `{ viable, offsetC, projectedNet, reason }`.

The signal function is pure: `(snapshot, config) -> MintPremiumOpportunity`.
No side effects, no API calls.

---

## 3. Risk Management

**Position sizing:** Full-Kelly (the edge is mechanical and bounded),
capped by exposure limit.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 1.0 | Full Kelly on a bounded-loss mint cycle |
| `maxExposure` | 0.25 | Max 25% of bankroll in active cycles |
| `bankroll` | $10,000 | Total available capital |
| `hurdleRate` | 0.0133 | Minimum net return per cycle (1.33%) |

**Pre-trade checks (in order):**

1. **Market cutoff** — reject if `timeToClose < 24h`. Shorten cycle
   target if `24h ≤ timeToClose < 48h`.
2. **Exposure check** — reject if active capital would exceed
   `maxExposure * bankroll`.
3. **Hurdle gate** — reject if `projectedNet / cycleCapital < hurdleRate`.
4. **Capture-rate sanity** — if per-leg `trade_count_1h < 3`, only
   proceed with the defensive `+0.5c` offset and emit a warning.

Risk checks run in dry-run only. Scanner output shows whether each
viable opportunity would pass the full gate stack.

---

## 4. Execution

**Out of scope for this template.** MINT-04 scanner emits opportunities
and projected nets; the operator runs the mint + post cycle manually or
via a future execution adapter.

**Scan layer:**

1. `searchMarkets()` — fetch candidate binary markets.
2. Filter by `volume_24h > volume24hThreshold`.
3. Fetch `trade_count_1h`, `bid_ask_spread`, `midpoint`, `timeToClose`
   per market.
4. Return `MintPremiumSnapshot[]` to the signal layer.

Market-data adapter may not surface `trade_count_1h` or
`bid_ask_spread` directly — see `TODO(adapter)` in `scan.ts`. Tests
stub the snapshot shape.

**Configuration:**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `kellyFraction` | 1.0 | Full-Kelly sizing |
| `maxExposure` | 0.25 | Max bankroll share in active cycles |
| `hurdleRate` | 0.0133 | Minimum net return per cycle |
| `feeRate` | 0.0017 | Flat USD fee per $1,000 cycle |
| `gasCost` | 0.05 | Flat gas (USD) per cycle |
| `lpRebate` | 0.275 | LP credit per $1,000 cycle (USD) |
| `offsetDefaultC` | 0.0075 | Default offset (mid-volume) |
| `offsetAggressiveC` | 0.01 | High-volume offset |
| `offsetDefensiveC` | 0.005 | Low per-leg activity offset |
| `volume24hThreshold` | 20_000 | Scan floor / confluence threshold |
| `trades1hThreshold` | 10 | Confluence trade-count threshold |
| `spreadThreshold` | 0.015 | Confluence max spread |
| `volumeAggressiveThreshold` | 50_000 | Aggressive-offset volume floor |
| `volumeDowngradeThreshold` | 10_000 | MINT-02 advisory floor |
| `minTradesPerHour` | 3 | Per-leg activity floor |
| `timeToCloseRejectMs` | 24h | Hard cutoff |
| `timeToCloseAdjustMs` | 48h | Shorten-cycle threshold |
| `signalTtlMs` | 6h | Signal time-to-live |

---

## 5. Monitoring

**Structured logging:** Pipeline decisions emit via the shared
`runner.ts` JSONL log.

**Log entry types:**

- `signal` — viable opportunity (market, offset, projected net)
- `advisory` — downgrade to MINT-02 for sub-$10k volume markets
- `warning` — `low_activity` per-leg, offset downgraded to `+0.5c`
- `risk_check` — risk decision (approved/rejected, reason)
- `error` — pipeline error (message, stage)

**Dry-run mode only:** No `mint_set`, no `postLimitOrder`. Operators
observe which markets would be minted and the projected net, without
capital at risk.

**Signal TTL:** Default 6h. Market-making cycles are long-lived
(fills accumulate over hours), so TTL is much longer than the
arbitrage templates.

---

## Next steps (out of scope for this port)

- Execution adapter: `mint_set` tx + paired `postLimitOrder` calls.
- Fill-tracking / reposition loop when one leg fills and the other drifts.
- Automated inventory rebalancing when cycles accumulate unfilled legs.
