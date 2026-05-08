---
name: backtesting
description: How to test strategies against historical data and interpret results
version: 1.0.0
domain: prediction-markets
requires: [prediction-markets, risk-management]
tools: []
---

# Backtesting Methodology

## Context
Load this skill when testing strategies or interpreting backtest results.

## Core Knowledge

### What Backtesting Proves (and Doesn't)
- **Proves:** Strategy logic executes correctly, no runtime errors
- **Proves:** Strategy would have generated signals on historical data
- **Does NOT prove:** Strategy will be profitable in the future
- **Does NOT prove:** Historical conditions will repeat
- **Key principle:** A backtest is a minimum bar, not a guarantee

### Backtest Parameters
- `timeframe`: How far back to test (default 7d, recommend 30d+ for confidence)
- `market_id`: Specific market to test against (optional — tests against category if omitted)
- `slippage_model`: Simulate realistic fill prices (default: 1% slippage)
- Fee model: Include taker fees in P&L calculation

### Interpreting Results

| Metric | Good | Concerning | Bad |
|--------|------|------------|-----|
| Win rate | >55% | 45-55% | <45% |
| Profit factor | >1.5 | 1.0-1.5 | <1.0 |
| Max drawdown | <10% | 10-20% | >20% |
| Sharpe ratio | >1.0 | 0.5-1.0 | <0.5 |
| Trade count | >30 (statistical significance) | 10-30 | <10 (meaningless) |

### Avoiding Overfitting
- Out-of-sample testing: Split data — train on 70%, test on 30%
- Walk-forward analysis: Retrain periodically on expanding window
- Parameter stability: Small parameter changes shouldn't destroy performance
- Simplicity test: If strategy has >5 tunable parameters, it's probably overfit

## Decision Frameworks

### Backtest → Deploy Decision
1. All risk checks pass? → Continue
2. Win rate >50% AND profit factor >1.2? → Continue
3. Max drawdown <15%? → Continue
4. Trade count >30? → Continue
5. Passes out-of-sample test? → Continue
→ All five pass → Ready for paper trading / deploy
→ Any fail → Iterate on strategy logic

## Common Mistakes
- **Survivorship bias:** Testing only on markets that resolved cleanly
- **Look-ahead bias:** Using information that wasn't available at trade time
- **Insufficient data:** Drawing conclusions from <10 trades
- **Ignoring slippage:** Backtest assumes perfect fills, reality doesn't
