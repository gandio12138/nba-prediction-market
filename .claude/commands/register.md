# Register

@description Register a QA-approved strategy on Canon Arena for performance tracking.

Load agents: risk-analyst, deployment-ops.
Load skills: risk-management, arena-tracking.

This workflow requires a QA-approved strategy (from /develop) as input.
Run every step below in order. Do not skip steps.

## 1. Risk review

As risk-analyst, evaluate the strategy's risk and portfolio impact.

Load skills: risk-management, prediction-markets.

Steps:
1. Review `src/types/RiskInterface.ts` — verify hard limits are enforced:
   - Single position limit ≤5% of portfolio
   - Correlated exposure limit ≤15% of portfolio
   - Daily loss limit trigger at -3%
   - Maximum drawdown halt at -10%
2. Check current portfolio state: `canon-cli position list` and `canon-cli balance`
3. Assess correlation with existing positions
4. Validate position sizing is within portfolio limits

Verdict:
- **Approved:** All limits verified, portfolio impact acceptable → proceed
- **Conditional:** Minor issues requiring modification → specify required changes
- **Rejected:** Hard limits not implemented or portfolio impact too large → return to dev

Do not proceed to pre-registration if rejected.

## 2. Pre-registration checklist

As deployment-ops, run the complete pre-registration checklist.

Load skill: arena-tracking.

Verify each item:
- [ ] All tests pass (`npm test`)
- [ ] Lint clean (`npm run lint`)
- [ ] Types valid (`npx tsc --noEmit`)
- [ ] RiskInterface implemented with hard limits
- [ ] Backtest results acceptable (win rate >50%, profit_factor >1.0)
- [ ] `dega-core.yaml` configured with appropriate budget limits
- [ ] Strategy name and description set in `package.json`
- [ ] Polymarket wallet address configured

If any item fails, stop and resolve before proceeding.

## 3. Register

Register the strategy on Canon Arena via the Arena dashboard.
Record the registration confirmation (strategy ID, Arena URL).

## 4. Verify and monitor

Verify registration and set up monitoring:

1. Confirm strategy is visible on Arena leaderboard with correct metadata
2. Verify P&L tracking is active: `canon-cli position list`
3. Configure alert thresholds:
   - Daily loss alert at -2% (warning before -3% circuit breaker)
   - API error alert at >3 errors/hour (warning before 5-error auto-pause)

Report:
- Registration status (success/failure)
- Arena leaderboard URL
- Initial portfolio metrics
- Alert configuration summary

## Completion criteria

- Risk analyst approval documented
- All pre-registration checklist items pass
- Strategy tracked on Arena (visible on leaderboard)
- P&L tracking active
- Monitoring alerts configured
