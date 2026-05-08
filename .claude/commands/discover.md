# Discover

@description Analyze markets, identify opportunities, and generate a strategy design specification.

Load agents: market-analyst, strategy-architect.
Load skills: prediction-markets, polymarket, strategy-patterns, risk-management.

Run every step below in order. Do not stop between steps.

## 1. Scan markets

As market-analyst, research available prediction markets using web search
and the Polymarket API documentation (https://docs.polymarket.com/).

Scan for:
- Notable price movements (>10% in 24h)
- Volume spikes indicating information events
- New markets with thin liquidity and potential mispricing
- Upcoming resolution events within 7 days

Apply prediction-markets and polymarket skills.

Output: Market scan report listing at least 3 opportunities, each with:
- Market ID and current price
- Estimated edge (your probability vs market price)
- Liquidity assessment
- Resolution timeline

## 2. Select opportunity

Rank opportunities from the scan report by:
1. Edge size (larger is better)
2. Liquidity (sufficient to enter/exit cleanly)
3. Resolution clarity (unambiguous criteria preferred)
4. Capital efficiency (shorter resolution timeline preferred)

Select the top candidate. Document your ranking rationale.

Output: Selected market with full analysis — market ID, price, edge estimate with
reasoning, liquidity assessment, and resolution timeline.

## 3. Design strategy

As strategy-architect, design a strategy for the selected opportunity.

Load skills: strategy-patterns, risk-management, prediction-markets.

Steps:
1. Select the strategy archetype that best matches the opportunity
   (see strategy-patterns skill — choose from momentum-trader, contrarian-fade,
   arbitrage-scanner, news-sentiment, portfolio-rebalancer, volatility-harvester)
2. Design entry and exit signal logic (pseudocode is fine)
3. Define risk parameters:
   - Position size (must be ≤5% of portfolio)
   - Stop-loss threshold
   - Circuit breaker conditions
4. Define backtest success criteria:
   - Minimum win rate (recommend >55%)
   - Minimum profit factor (recommend >1.2)
   - Maximum drawdown (recommend <15%)
   - Minimum trade count (must be ≥30)

Output: Complete strategy design specification.

## Completion criteria

- Market scan report with ≥3 opportunities produced
- Single opportunity selected with documented rationale
- Strategy design specification includes: archetype, entry/exit logic,
  risk parameters, backtest success criteria, target market IDs
- Specification is ready to hand off to the develop workflow
