# Plan: NBA Championship Futures Scanner

**Status:** In progress
**Created:** {{DATE}}

## Requirements

Implement the NBA Championship Futures Scanner from `docs/strategy-nba-momentum.md`.
Bootstrapped files (runner, types, test harness, clients) are already in place.
Build the decision logic, config, and risk management.

### Quality bar

- `tsc --noEmit` passes (zero errors)
- `oxlint src/` passes (zero warnings)
- `vitest run` passes (all tests green)
- Dry-run runner starts and writes at least one `.canon/execution/*.jsonl` entry

## Domain layering

```
src/types/game.ts              ← Layer 1: Types (bootstrapped)
src/types/TradeSignal.ts       ← Layer 1: Types (bootstrapped)
src/types/RiskInterface.ts     ← Layer 1: Types (bootstrapped)
src/clients/polymarket.ts      ← Layer 2: Clients (bootstrapped)
src/clients/sportsbook.ts      ← Layer 2: Clients (bootstrapped)
src/config/strategy.ts         ← Layer 2: Config (BUILD)
src/config/risk.ts             ← Layer 2: Config (BUILD)
src/service/signals.ts         ← Layer 3: Service (BUILD)
src/service/risk.ts            ← Layer 3: Service (BUILD)
src/strategy.ts                ← Layer 4: Strategy (BUILD)
src/runner.ts                  ← Layer 5: Runtime (bootstrapped)
```

## Progress log

- [x] Bootstrap types: `src/types/game.ts` (TeamComparison)
- [x] Bootstrap types: `src/types/TradeSignal.ts`, `src/types/RiskInterface.ts`
- [x] Bootstrap clients: `src/clients/polymarket.ts`, `src/clients/sportsbook.ts`
- [x] Bootstrap runner: `src/runner.ts` (polling loop, championship futures scan, team matching, JSONL logger, SIGINT handler)
- [x] Bootstrap test harness: `src/__tests__/strategy.test.ts` (factories, test shells)
- [ ] Create `src/config/strategy.ts` — export `StrategyConfig` interface (`mispricingThreshold: number`, `sportKey: string`, `searchQuery: string`, `pollIntervalMs: number`) and `DEFAULT_CONFIG` with values from strategy spec (0.005, `basketball_nba_championship_winner`, `NBA Finals`, 30000)
- [ ] Create `src/config/risk.ts` — export `RiskConfig` interface (`minBookmakerSources: number`, `maxDeltaPercent: number`) and `DEFAULT_RISK_CONFIG` with values from strategy spec (2, 0.50)
- [ ] Create `src/service/signals.ts` — export `SignalCheck` interface (`delta: number`, `absDelta: number`, `direction: "sportsbook higher" | "Polymarket higher"`) and `shouldFlag(sportsbookProb: number, polymarketPrice: number, config: StrategyConfig): SignalCheck | null` — returns signal info if `|delta| >= threshold`, null otherwise. Runner imports this.
- [ ] Create `src/service/risk.ts` — export `checkRiskLimits(params: { sources: number }, config: RiskConfig): boolean` — returns true if sources >= minBookmakerSources. Runner imports this.
- [ ] Create `src/strategy.ts` — export `FuturesScanner` class: constructor takes `StrategyConfig` + `RiskConfig`, method `evaluate(comparisons: TeamComparison[]): SignalResult[]` — loops comparisons, calls `checkRiskLimits` then `shouldFlag`, returns signal results. Tested but not used by runner.
- [ ] Fill in remaining TODO test assertions in `src/__tests__/strategy.test.ts` — verify shouldFlag thresholds, checkRiskLimits min-sources, FuturesScanner wiring
- [ ] Run `pnpm exec tsc --noEmit` — zero errors
- [ ] Run `pnpm exec oxlint src/` — zero warnings
- [ ] Run `pnpm exec vitest run` — all tests pass

## Completion criteria

- [ ] `pnpm exec tsc --noEmit` exits 0
- [ ] `pnpm exec oxlint src/` exits 0
- [ ] `pnpm exec vitest run` exits 0 (all tests pass)
