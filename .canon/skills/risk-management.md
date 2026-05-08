---
name: risk-management
description: Position sizing, exposure limits, portfolio risk rules
version: 1.0.0
domain: risk
requires: [prediction-markets]
tools: []
---

# Risk Management Patterns

## Context
Load this skill for ANY strategy development. Risk management is not optional.
Every strategy must implement the RiskInterface. This skill defines the rules.

## Core Knowledge

### Non-Negotiable Rules (Hard Limits)
1. **Single position limit:** Never >5% of portfolio on one market
2. **Correlated exposure limit:** Never >15% of portfolio on correlated positions
3. **Daily loss limit:** Stop trading if daily P&L drops below -3% of portfolio
4. **Maximum drawdown:** Halt all execution if portfolio drops >10% from peak
5. **Always implement RiskInterface:** No exceptions, no shortcuts

### Position Sizing
- Start with half-Kelly criterion (conservative)
- Adjust for liquidity: Reduce size if order book is thin
- Adjust for correlation: Reduce size if you hold related positions
- Adjust for conviction: Scale with edge size, but never exceed hard limits

### Portfolio Construction
- Diversify across market categories (sports, politics, crypto, events)
- Diversify across resolution timelines (short, medium, long)
- Maintain cash reserve: Keep >30% of portfolio in USDC (not deployed)
- Rebalance when any position exceeds 5% threshold

### Risk Monitoring
- Real-time P&L tracking via portfolio monitoring scripts
- Portfolio heat map: Which positions are driving variance
- Correlation matrix: Which positions move together
- Time-to-resolution: Capital efficiency optimization

## Decision Frameworks

### Pre-Trade Risk Check (Required)
Before every trade, verify:
1. Position size < 5% of portfolio ✓
2. Total correlated exposure < 15% ✓
3. Daily P&L above -3% threshold ✓
4. Portfolio drawdown above -10% threshold ✓
5. Order book has sufficient liquidity for target size ✓
→ All five pass → Execute trade
→ Any one fails → Reject trade

### Emergency Procedures
- Circuit breaker triggered → Halt all execution, notify human
- Flash crash detected → Do NOT market sell (will get worst fill), wait for recovery
- API outage → Cancel all open orders, wait for reconnection
- Resolution dispute → Freeze affected positions, do not add exposure

## Common Mistakes
- **Scaling too fast:** Doubling down after a win ("hot hand fallacy")
- **Revenge trading:** Increasing size after a loss to "make it back"
- **Ignoring correlation:** Three NBA bets on the same night are NOT diversified
- **No stop-loss logic:** Letting losing positions run without limits
- **Skipping the RiskInterface:** "I'll add it later" → You won't, and the strategy blows up
