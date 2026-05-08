---
name: arena-tracking
description: How to register strategies on Canon Arena for performance tracking and monitoring
version: 1.0.0
domain: workflow
requires: [risk-management]
tools: [canon-cli]
---

# Arena Tracking

## Context
Load this skill when registering a strategy on Canon Arena or monitoring tracked performance.

Arena is a **performance tracking dashboard** — it monitors registered Polymarket accounts
and displays charts, leaderboards, and portfolio data. Arena does not host execution
infrastructure; strategies run on users' own machines.

## Core Knowledge

### Registration Pipeline
1. **Validation:** Strategy implements TradeSignal and RiskInterface
2. **Testing:** `vitest run` passes with acceptable metrics
3. **Configuration:** Strategy configured with Polymarket wallet address
4. **Registration:** Strategy registered with Arena (name, description, author, wallet)
5. **Tracking:** Arena begins monitoring the Polymarket account and displaying performance

### Pre-Registration Checklist
- [ ] All tests pass (`npm test`)
- [ ] Lint clean (`npm run lint`)
- [ ] Types valid (`npx tsc --noEmit`)
- [ ] RiskInterface implemented with hard limits
- [ ] Backtest results acceptable (see backtesting skill)
- [ ] dega-core.yaml configured with appropriate budget limits
- [ ] Strategy name and description set in package.json
- [ ] Polymarket wallet address configured

### Arena Integration
- Leaderboard: Strategy ranked by portfolio value, ROI, win rate
- Strategy cards: Public profile showing performance metrics
- Portfolio tracking: Real-time P&L from Polymarket account visible on Arena dashboard
- Status: Active / Paused / Stopped

### Monitoring Live Strategies
- Check P&L: `canon-cli position list` (includes PnL summary)
- Check positions: `canon-cli position list`
- Check portfolio: `canon-cli balance`
- Arena dashboard: Real-time leaderboard position

## Decision Frameworks

### When to Pause/Stop a Strategy
- Daily loss exceeds -3% → Auto-pause (circuit breaker)
- Drawdown exceeds -10% → Auto-stop
- API errors >5 in 1 hour → Auto-pause, alert human
- Manual override: Always available via Arena dashboard

## Common Mistakes
- **Deploying without backtest:** "It compiled, ship it" → Strategy loses money immediately
- **No budget limits:** Strategy burns through budget on bad trades
- **Ignoring monitoring:** Deploy and forget → miss early warning signs
- **Missing API keys:** Strategy deploys but can't execute → silent failure
