# Ralph Cycle

@description Autonomous iteration loop — execute, check, iterate until all success criteria pass or budget is exhausted.

Load agent: dev.
Load skills: orchestrator, canon-conventions.

Run every step below. The loop repeats steps 1-3 until the SHIP or ESCALATE condition is met.

**State write convention:** Every `terminal-ui-write.sh` call below is guarded — check
if the script exists and skip silently if not. Do not warn about missing dashboard.

## 1. Execute

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=execute status=running log.info="Iteration ${ITERATION:-1}: executing..."
```

Implement or modify code toward the success criteria defined in `.canon/dega-core.yaml`.

Load skills: canon-conventions, orchestrator.

Input:
- Task description
- Success criteria from `.canon/dega-core.yaml`
- Feedback from previous iteration (if any)

Apply changes. Follow domain layering and error message conventions.

## 2. Check

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=check status=running log.info="Running success criteria checks..."
```

Run every check command listed in `.canon/dega-core.yaml` under `success_criteria`.

For each entry, run the `check` command (e.g., `pnpm exec tsc --noEmit`,
`pnpm exec oxlint src/`, `pnpm exec vitest run`).

Record each criterion: pass ✓ or fail ✗ with the specific failure message.

## 3. Analyze (if checks failed)

If any check failed, analyze the failures before the next iteration:

1. Identify root cause of each failure
2. Plan the fix — be specific (which file, which line, what change)
3. Estimate confidence: Is this fix likely to resolve the failure?

If stuck (same failure across 3+ iterations without progress), escalate immediately
rather than burning more budget.

## 4. Loop or ship

Evaluate the current state:

**SHIP if:**
- All success criteria pass → Write state update and summary, exit loop:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    status=idle log.info="SHIP — all criteria met"
```

**LOOP if:**
- Any criterion failed AND iteration count < `max_iterations` AND budget remaining
→ Apply the fix plan from step 3, return to step 1

**ESCALATE if:**
- Iteration count ≥ `max_iterations`, OR
- Budget exhausted (`max_tokens` or `max_spend` reached), OR
- Stuck (same failure ≥3 iterations without progress)

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    status=error error="Escalated — human intervention required"
```

→ Document: which criteria are failing, what was tried, why it's stuck
→ Surface to human for intervention

## Completion criteria

- **SHIP:** All success criteria pass
- **ESCALATE:** Budget/iteration limit reached, or stuck — with full failure report
  for human review
