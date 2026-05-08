# Develop

@description Scaffold, implement, test, and iterate on a strategy until it passes QA.
@arguments $DESIGN_SPEC: Path to the strategy design specification (from /discover or provided directly)

Load agents: dev, qa.
Load skills: canon-conventions, backtesting, orchestrator, risk-management.

Run every step below in order. Do not stop or ask for confirmation between steps.

**State write convention:** Every `terminal-ui-write.sh` call below is guarded — check
if the script exists and skip silently if not. Do not warn about missing dashboard.

## 1. Verify scaffold

As dev, verify the project scaffold exists before implementing.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=scaffold status=running log.info="Verifying scaffold..."
```

Check that these files are present:
- `package.json`
- `tsconfig.json`
- `src/types/TradeSignal.ts`
- `src/types/RiskInterface.ts`
- `.canon/dega-core.yaml`
- `.canon/config.yaml`
- `AGENTS.md`

If any are missing, stop and tell the user:

> Project scaffold is incomplete. Run `/canon-init` first to set up the Canon
> framework, then re-run `/develop`.

## 2. Implement

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=develop status=running log.info="Implementing strategy..."
```

Implement strategy logic from the design specification.

Load skills: canon-conventions, risk-management.

Required:
- Implement `TradeSignal` interface in `src/strategy.ts`
- Implement `RiskInterface` in `src/types/RiskInterface.ts` with the hard limits
  from the design specification
- Follow domain layering: Types → Config → Repo → Service → Runtime → UI
- Use agent-oriented error messages (what/why/how format)

Do not skip RiskInterface. "I'll add it later" is not acceptable.

## 3. Test

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=test status=running log.info="Running checks..."
```

Run every check command from `.canon/dega-core.yaml` `success_criteria`:

```
pnpm exec tsc --noEmit
pnpm exec oxlint src/
pnpm exec vitest run
```

All three must pass. If `.canon/dega-core.yaml` has additional strategy-specific
checks beyond these defaults, run those too.

Review test results against the design spec's success criteria — tests passing
is the minimum bar, also check backtest metrics if applicable.

## 4. Iterate (Ralph Loop)

If any checks from step 3 fail, or backtest criteria from the design spec are
not met, iterate:

1. Read the failing check output to identify what broke.
2. Fix the issue in code.
3. Re-run all check commands from `.canon/dega-core.yaml` `success_criteria`.
4. Repeat until all checks pass.

Load orchestrator skill for iteration guidance.

The `max_iterations` in `.canon/dega-core.yaml` limits how many cycles to attempt.
If the limit is reached without meeting all criteria, surface the specific
failing criteria for human review before proceeding.

## 5. QA review

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=qa status=running log.info="QA review..."
```

As qa, validate strategy quality.

Load skills: canon-conventions, backtesting, risk-management.

Check:
1. Code conventions: Domain layering respected, error messages follow what/why/how
2. Backtest results across multiple timeframes (7d, 30d, 90d if data available)
3. No overfitting signals (parameter stability, out-of-sample test)
4. RiskInterface correctly enforces hard limits (not just present — verify logic)
5. Edge cases: zero liquidity, API timeout, zero balance

Verdict:
- **Approved:** All criteria met → output QA-approved summary, proceed to register workflow
- **Return to dev:** Specific blocking issues found → list each issue with severity
  (blocking / advisory) and suggested fix → loop back to step 2

## Completion criteria

- Tests pass (`pnpm exec vitest run`)
- Lint clean (`pnpm exec oxlint src/`)
- Types valid (`pnpm exec tsc --noEmit`)
- Backtest criteria from design spec met
- QA approved (≥30 trades, profit_factor ≥1.0, no blocking biases)
- QA-approved strategy ready to hand off to register workflow
