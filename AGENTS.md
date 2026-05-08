# Canon Strategy Development

## Quick Reference
- Framework config: `.canon/config.yaml`
- Ralph Loop config: `dega-core.yaml`
- Agent personas: `.canon/agents/`
- Skills (domain knowledge): `.canon/skills/`

## Available Agents

| Agent | Role | Load When |
|-------|------|-----------|
| strategy-architect | Designs strategies from market analysis | Starting a new strategy |
| market-analyst | Interprets market data, finds opportunities | Exploring markets |
| dev | Implements strategies in TypeScript | Writing code |
| qa | Validates quality and standards compliance | Reviewing before registration |
| risk-analyst | Evaluates risk and portfolio impact | Before registration |
| deployment-ops | Registers on Arena, monitors tracked performance | Registering a strategy |

## Available Commands

| Command | Purpose |
|---------|---------|
| `/canon-start` | Guided workflow — detects project state, drives full pipeline |
| `/develop` | Scaffold, implement, test, iterate (full build cycle) |
| `/ralph-cycle` | Execute success criteria checks and iterate until SHIP |
| `/discover` | Market analysis, opportunity identification, strategy design |
| `/register` | Risk review, pre-registration checks, Arena tracking |
| `/quick-dev` | Small changes with lightweight validation |

## Non-Negotiable Rules
1. All strategies implement TradeSignal + RiskInterface
2. Position size never >5% of portfolio
3. Domain layering: Types -> Config -> Repo -> Service -> Runtime -> UI
4. Error messages include what/why/how
5. "If it's not in the repo, it doesn't exist"
