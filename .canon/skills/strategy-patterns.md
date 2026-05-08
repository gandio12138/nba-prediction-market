---
name: strategy-patterns
description: Common prediction market strategy archetypes and when to use them
version: 1.0.0
domain: prediction-markets
requires: [prediction-markets, risk-management]
tools: [canon-cli]
---

# Strategy Patterns

## Context
Load this skill when designing a new strategy or helping a user choose an approach.
Each pattern maps to a `/canon-init` template.

## Core Knowledge

### Pattern 1: Momentum Trading
- **Thesis:** Prices trend — buy rising, sell falling
- **Edge:** Information takes time to fully price in
- **Signal:** Odds velocity (rate of price change over time window)
- **Risk:** False breakouts, mean reversion after overextension
- **Template:** `/canon-init --template momentum-trader`
- **Best for:** High-volume markets with frequent information events

### Pattern 2: Contrarian / Mean Reversion
- **Thesis:** Extreme prices revert toward fair value
- **Edge:** Crowd overreaction to news events
- **Signal:** Price deviates >15% from 7-day moving average
- **Risk:** Markets can stay irrational — "the trend is real, not an overreaction"
- **Template:** `/canon-init --template contrarian-fade`
- **Best for:** Markets with high volatility and strong anchor points

### Pattern 3: Arbitrage
- **Thesis:** Correlated markets misprice relative to each other
- **Edge:** Pure mathematical — no prediction needed
- **Signal:** Cross-market price discrepancy exceeds transaction costs
- **Risk:** Execution risk (one leg fills, other doesn't), resolution risk
- **Template:** `/canon-init --template arbitrage-scanner`
- **Best for:** When same event trades on multiple platforms or in related markets

### Pattern 4: News / Sentiment
- **Thesis:** AI can process news faster than markets price it
- **Edge:** Speed of information processing
- **Signal:** Sentiment shift detected in news/social media before price moves
- **Risk:** Fake news, misinterpretation, already priced in
- **Template:** `/canon-init --template news-sentiment`
- **Best for:** Markets sensitive to breaking news (politics, current events)

### Pattern 5: Portfolio Rebalancing
- **Thesis:** Maintain target allocation across markets for consistent returns
- **Edge:** Discipline and diversification
- **Signal:** Portfolio drift from target weights
- **Risk:** Rebalancing into losing positions (systematic value trap)
- **Template:** `/canon-init --template portfolio-rebalancer`
- **Best for:** Conservative, long-term strategies with multiple active markets

### Pattern 6: Volatility Harvesting
- **Thesis:** Profit from price swings regardless of direction
- **Edge:** Markets oscillate around fair value — buy dips, sell rips
- **Signal:** Price touches upper/lower band of recent range
- **Risk:** Breakout (price leaves range permanently)
- **Template:** `/canon-init --template volatility-harvester`
- **Best for:** Range-bound markets with high trading volume

## Decision Frameworks

### Choosing a Strategy Pattern
1. What's your edge? (Speed, analysis, discipline, math)
2. What market type? (Sports, politics, crypto, events)
3. What time horizon? (Minutes, hours, days, weeks)
4. What's your risk tolerance? (Aggressive, moderate, conservative)
5. What data is available? (Price only, news, social, on-chain)

→ Map answers to pattern that best fits

## Common Mistakes
- **Pattern mismatch:** Using momentum strategy in a range-bound market
- **Over-complexity:** Combining too many signals — simple strategies usually win
- **Backtest overfitting:** Strategy works perfectly on historical data but fails live
- **Ignoring regime changes:** Strategy designed for calm markets breaks during high-vol events
