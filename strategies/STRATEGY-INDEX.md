# Strategy Template Index

Source: `C2_Plantillas18Estrategias_AgentesAI.docx` and
`D2_Plantillas18_InyeccConfiguracion.docx`

Tracks which strategies from the 18-template library have been ported
into `canon/templates/` as runnable strategy directories.

## Status legend

- **Turnkey (live)** — runs end-to-end live with `--live`. No operator code required.
- **Live executor wired, cycle loop pending** — `--live` plumbing done (executor, allowance, sidecar preflight) but the orchestration loop that drives a complete cycle is not. Cannot trade today.
- **Extension scaffold** — wiring in place as a community example / base for extension. Not a runnable strategy out of the box and not on Canon's roadmap to complete.
- **Planned** — will be ported, not yet started.
- **Deferred** — requires infrastructure not yet built (Phase 2/3).

## Code freeze (2026-04-30)

Strategy templates are code-frozen at this revision pending demo
testing and bug fixes. New strategies and cycle-loop completions
resume after the freeze lifts.

---

## Group 1 — Pure Arbitrage

| ID | Name | Risk | Complexity | Scanner-ready? | Status | Notes |
|----|------|------|------------|----------------|--------|-------|
| ARB-01 | Binary Arb Buy (YES+NO < $1) | Very Low | Low | Yes | **Turnkey (live)** | `strategies/arb-binary/` — scanner + risk checks + live CLOB execution behind `--live`. Self-contained: no operator config, no pending pieces |
| ARB-02 | Binary Arb Sell / Mint | Very Low | Medium | Yes | Planned | Requires CTF mint tx (4-6s latency) |
| ARB-03 | NegRisk Multi-condition Buy | Low | Medium | Yes | **Turnkey (live)** | `strategies/arb-negrisk-buy/` — multi-leg scanner + risk + live FOK CLOB legs behind `--live`. SDK does not surface `neg_risk` flag yet; scan uses outcomes>2 + Σ yes_ask < 1 confirmation as the sufficient filter |
| ARB-04 | NegRisk Multi-condition Sell | Medium | High | No | Deferred | Mint set + parallel sell, ~5% of markets |
| ARB-05 | Cross-Market Combinatorial | Medium | Very High | No | Deferred | LLM + IP Solver, $500k+ capital, Phase 3 |

## Group 2 — Minting & Market Making

| ID | Name | Risk | Complexity | Scanner-ready? | Status | Notes |
|----|------|------|------------|----------------|--------|-------|
| MINT-01 | Simple Mint $1,000 | Low | Low | No (exec) | **Live executor wired, cycle loop pending** | `strategies/mint-01/` — `cycle.ts` helpers (`selectMarket`, `planLegs`, `shouldStopLoss`), `ctf-mint.ts` splitPosition wrapper, live executor + allowance + sidecar preflight all built. `main()` does **not** orchestrate them yet — running `--live` today prints START and exits. Cannot trade. |
| MINT-02 | Split Mint $500+$500 | Very Low | Low | No (exec) | Planned | Two sub-cycles, adjustable between |
| MINT-03 | MM at Midpoint (Passive) | Medium | Medium | No (exec) | Planned | LP rewards only, loses on execution |
| MINT-04 | MM Premium +0.75c | Low | Medium | No (exec) | **Live executor wired, cycle loop pending** | `strategies/mm-premium/` — scanner with tiered offset (1.0¢ / 0.75¢ / 0.5¢), risk gate, live GTC sell limit executor wired behind `--live`. Missing: own `cycle.ts` helpers (mirror `mint-01/cycle.ts`) and the orchestration loop (splitPosition mint + dual leg + 24h reconcile). Cannot trade today |
| MINT-05 | MM Sweet Spot (Dynamic) | Low | Medium | No (exec) | Planned | Auto-adjusts offset 0.25-0.50c |
| MINT-06 | Compounding Multi-Cycle | Low | Low | No (exec) | Planned | Meta-strategy, reinvests MINT-01/04 |

## Group 3 — Active Trading

| ID | Name | Risk | Complexity | Scanner-ready? | Status | Notes |
|----|------|------|------------|----------------|--------|-------|
| TRADE-02 | Momentum Trading | Medium | Medium | Yes | **Turnkey (live)** | `strategies/trade-momentum/` — scanner (price velocity, RSI, MACD, volume percentile, OI trend) + risk + live GTC limit buy on YES behind `--live`. Buy rising (10-30%), sell at ~50%. `topWalletShare` gated to 0 — manipulation guard is no-op until an on-chain indexer is wired (Phase 2). Self-contained otherwise |

## Group 4 — AI & Advanced Automation

| ID | Name | Risk | Complexity | Scanner-ready? | Status | Notes |
|----|------|------|------------|----------------|--------|-------|
| IA-01 | News Front-Running | Medium | High | Yes (scanner) | Deferred | Needs Reuters/AP APIs, <500ms, Phase 3 |
| IA-02 | Whale Copy-Trading | Medium | High | Yes (scanner) | Deferred | On-chain indexer, <2s replica, Phase 2 |
| IA-03 | Fair Value Model | Medium | High | Yes (scanner) | **Extension scaffold (community example, not on Canon roadmap)** | `strategies/fair-value/` — live executor + scan + risk wired behind `--live`, but ships with `NEUTRAL_MODEL` (confidence=0, no signals fire). Operator must supply a numeric `ProbabilityModel` (ELO, base rates, vegas-implied; spec forbids LLM/news/sentiment — those belong to IA-01). Canon will not progress this further; preserved as a template for the community to extend |
| IA-04 | Arb Bot Types 1-3 | Low | Medium | Yes | Planned | Production bot of ARB-01/02/03 combined |
| IA-05 | LLM Dependency Detection | High | Very High | No | Deferred | $500k+, LLM+Solver, 15-35s latency |
| IA-06 | Bregman+Frank-Wolfe Optimizer | Low | High | N/A (layer) | Deferred | Transversal sizing layer, not standalone |

## Existing in repo

| Template | Source strategy | Status |
|----------|---------------|--------|
| `nba-momentum/` | Custom (cross-venue arb scanner) | Ported, dry-run only |

## Demo-ready summary (at code freeze)

**Turnkey live (3):** ARB-01, ARB-03, TRADE-02 — run `--live` end-to-end
today, no operator code or pending pieces.

**Live executor wired, cycle loop pending (2):** MINT-01, MINT-04 —
wiring and helpers built; orchestration loop missing (~2–3h work
each). Cannot trade today.

**Extension scaffold (1):** IA-03 — community template; not on Canon
roadmap.

**Not yet ported (12):** ARB-02, ARB-04, ARB-05, MINT-02, MINT-03,
MINT-05, MINT-06, IA-01, IA-02, IA-04, IA-05, IA-06.

## Post-freeze priority order

1. **MINT-01 cycle loop** — completes the pieces already built; turns
   wired-but-dormant into a fifth turnkey strategy.
2. **MINT-04 cycle loop** — same shape as MINT-01 plus its own
   `cycle.ts` helpers with tiered offset.
3. New strategies from the planned list (ARB-02, MINT-02, etc.)
   based on demand.

## Implementation path (for future ports)

**Scanner (dry-run):** strategy.md + config + runner that imports
shared `canon/templates/runner.ts`. Logs signals to JSONL. No wallet
needed, no execution.

**Live execution:** Same strategy, mirror the arb-binary pattern in
`entry.ts` — `parseEntryFlags` (`--live` opt-in), `createEntryDeps`
(live executor + positions + scan), `assertLiveCapabilities` (sidecar
TIF preflight), `buildLiveAllowanceClient` (USDC allowance via
injected `WalletStore`). Requires wallet auth + integration test
asserting CLOB-shaped tokenId + correct TIF on `createOrder` mock.
