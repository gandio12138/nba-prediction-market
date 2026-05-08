---
name: prediction-markets
description: Core concepts of prediction markets — mechanics, pricing, resolution
version: 1.0.0
domain: prediction-markets
requires: []
tools: [canon-cli]
---

# Prediction Market Fundamentals

## Context
Load this skill whenever working on prediction market strategies. This knowledge
is foundational — most other skills assume familiarity with these concepts.

## Core Knowledge

### How Prediction Markets Work
- Binary outcome contracts: YES shares + NO shares = $1.00
- Price = market-implied probability (e.g., YES at $0.65 = 65% implied probability)
- Resolution: Markets resolve to $1.00 (YES) or $0.00 (NO) based on real-world outcomes
- Trading profit comes from: buying underpriced outcomes, selling overpriced outcomes

### Market Mechanics
- Order book model: Limit orders create liquidity, market orders consume it
- Spread: Difference between best bid and best ask — represents trading cost
- Liquidity: Total value available to trade at current prices — low liquidity = high slippage
- Volume: Trading activity over time — indicates market interest and information flow

### Pricing vs Probability
- Market prices reflect consensus probability, NOT truth
- Mispricing opportunity exists when your estimate differs from market price
- Edge = Your probability estimate - Market implied probability
- Positive edge = market is underpricing your expected outcome

### Resolution Risk
- Markets only pay out after resolution — timing matters
- Resolution criteria may be ambiguous (contested outcomes)
- Resolution delays lock up capital (opportunity cost)
- Multi-outcome markets (e.g., "Who wins MVP?") have correlated positions

### Zero-Sum Nature
- Prediction markets are PvP (player vs player) — every dollar you win, someone else loses
- This is fundamentally different from equity markets (positive-sum long term)
- Strategy implication: You need an information or analytical edge, not just participation

## Decision Frameworks

### Should I Trade This Market?
1. Do I have an edge? (My probability estimate differs from market price by >5%)
2. Is there sufficient liquidity? (Can I enter/exit without >2% slippage)
3. What's the resolution timeline? (Capital lock-up cost)
4. What's the resolution risk? (Ambiguous criteria?)

### Position Sizing (Kelly Criterion Simplified)
- Never risk >5% of portfolio on a single market (hard rule)
- Kelly fraction = (edge / odds) — but use half-Kelly for safety
- Account for correlation: two NBA games on the same night are NOT independent

## Common Mistakes
- **Overconfidence bias:** Treating your probability estimate as certainty
- **Ignoring liquidity:** Placing large orders in thin markets (slippage eats edge)
- **Resolution risk blindness:** Not reading resolution criteria carefully
- **Correlated positions:** Betting heavily on multiple outcomes that move together
- **Ignoring fees:** Trading fees reduce effective edge — small edges become negative after fees

## Examples

### Example 1: NBA Playoff Game
Market: "Will the Celtics win Game 3?" — YES at $0.58
Your analysis: Celtics have 70% chance based on home court + rest advantage
Edge: 70% - 58% = +12% → Strong positive edge → Trade

### Example 2: Low Liquidity Trap
Market: "Will X bill pass Senate?" — YES at $0.40, but only $500 in order book
Your analysis says 60% probability (20% edge), but $500 liquidity means
a $200 order moves the price 8% → Slippage destroys your edge → Don't trade
