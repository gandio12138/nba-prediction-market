# Canon Start

@description Guided entry point for Canon prediction-market development — detects project phase and drives the full pipeline.

Run every step below in order. Do not stop between steps unless explicitly told to.

**Output rules — STRICT:**
- **Minimize tool calls.** Every Bash call prints output in the chat window.
  Combine checks into single scripts. Never run individual file-existence
  checks, ls commands, or env-var echoes as separate tool calls.
- **Suppress noisy output.** Redirect stdout/stderr to `/dev/null` on any
  check whose result you only need as an exit code (tests, tsc, lint).
- **One line per phase.** No blockquotes, bullet lists, log paths, status
  summaries, or explanatory paragraphs. The TUI dashboard shows state,
  metrics, and logs — never duplicate that in chat.
- **No narration.** Do not describe what you are about to do, what you just
  did, or what you found. Just do it and print the phase name.

---

## 0. Pre-flight — open the State panel

**ALWAYS run this bash block first**, before any phase detection, before
the live-mode short-circuit, before anything else. It opens the TUI's
State panel so the user can watch `.canon/state.json` updates land while
phases run. Silent no-op if `canon-ctl` is not on PATH. This step is
unconditional — it runs on every invocation, including `--live` reruns
that jump straight to Phase 8.

```bash
command -v canon-ctl >/dev/null && canon-ctl action "screen.show_state" || true
```

---

## 1. Initialize

**State write convention:** Every `terminal-ui-write.sh` call in steps 2–7 is guarded.
Before each call, check if the script exists and skip silently if it does not.

**Live-mode short-circuit.** If the user invoked `/canon-start --live` (look
for `--live` in the argument the slash command was called with), the project
must already be in dry-run-validated state from a prior `/canon-start`
invocation. Skip phases 2–7 entirely and jump to **Phase 8: live**. That
phase calls a deterministic shell script that handles deposit collection,
onboarding, and the live runner launch — do not reimplement any of it
inline. If `src/main.ts` does not exist, the script will fail with a clear
"run /canon-start in dry-run first" message and exit non-zero; do not
fall back to the dry-run flow.

For the standard (no `--live`) invocation, proceed directly to step 2.

---

## 2. Detect phase

Run this **single** bash block. Do NOT run individual checks — one command, one output line.

```bash
set -euo pipefail

phase="run"  # default — overridden below if earlier phase detected

# Phase: init
if [[ ! -d .canon ]]; then
  phase="init"
else
  # Phase: scaffold
  scaffold_ok=true
  for f in .canon/config.yaml dega-core.yaml package.json tsconfig.json \
           types/TradeSignal.ts types/RiskInterface.ts; do
    [[ -f "$f" ]] || { scaffold_ok=false; break; }
  done
  ls .canon/agents/*.md &>/dev/null || scaffold_ok=false
  ls .canon/skills/*.md &>/dev/null || scaffold_ok=false

  if [[ "$scaffold_ok" == false ]]; then
    phase="scaffold"
  else
    # Phase: strategy
    strategy_found=false
    ls docs/strategy-*.md &>/dev/null && strategy_found=true
    find . -maxdepth 3 -name '*.strategy.md' -print -quit 2>/dev/null \
      | grep -q . && strategy_found=true
    ls .canon/execution/*spec* &>/dev/null && strategy_found=true

    if [[ "$strategy_found" == false ]]; then
      phase="strategy"
    elif [[ ! -d src ]]; then
      phase="develop"
    else
      # Run checks silently — any failure means develop phase
      pnpm exec vitest run --reporter=dot &>/dev/null || phase="develop"
      if [[ "$phase" == "run" ]]; then
        pnpm exec tsc --noEmit &>/dev/null || phase="develop"
      fi
      if [[ "$phase" == "run" ]]; then
        pnpm run lint &>/dev/null || phase="develop"
      fi
    fi
  fi
fi

# Write state (silently)
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase="$phase" status=running log.info="Detected phase: $phase" &>/dev/null

echo "$phase"
```

The only output is the phase name (e.g. `run`). Print it as:

Phase: <phase>

Then jump to the step for that phase.

---

## 3. Phase: init

The project has no `.canon/` directory. Set up the Canon framework by running
the canon-init shell script. This is a deterministic, self-verifying script —
not an agent-driven process.

**Guard:** If the current directory is `claude-code-config` (this config repo itself),
stop and tell the user:

> Run `/canon-start` from inside your strategy project directory, not from
> `claude-code-config`. Navigate to your project first, then re-run.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=init status=running log.info="Initializing Canon framework..."
```

Run the canon-init script:

```bash
bash "${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/canon-scaffold.sh"
```

The script copies `canon/templates/` wholesale as the project root (runner,
types, strategies, configs), fetches agents, skills, and commands from GitHub,
and verifies every file is present before reporting success. It writes dashboard
state updates as it progresses (if terminal-ui-write.sh is installed).

**If the script exits non-zero**, stop and report the error to the user. Do not
attempt to fix or retry — the script already gives a clear error message.

**If the script succeeds**, print the summary it outputs and proceed to step 4.

After init completes, install dependencies:

```bash
pnpm install
```

Ensure a project-local burner wallet exists. Idempotent — generates one on
first run, reports the address (and a funding prompt) once, and is a no-op
on subsequent runs. This is the single entry point for wallet
auto-instantiation:

```bash
"${DEGA_CORE_HOME:-${HOME}/.degacore}/bin/canon-cli" wallet ensure --pretty
```

The wallet lives at `.canon/wallet.env` (mode 0600). Each Canon project gets
its own wallet, so different strategies in different projects trade from
different accounts automatically. When `created: true` appears in the
output, tell the user to fund the printed address with USDC.e on Polygon
before running any strategy.

Proceed to step 4 (scaffold verification).

---

## 4. Phase: scaffold

The `.canon/` directory exists but may be incomplete. Verify and fill gaps.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=scaffold status=running log.info="Verifying scaffold completeness..."
```

Check each required scaffold file from the list in step 2. If files are missing,
run the canon-init script with `--force` to regenerate them:

```bash
bash "${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/canon-scaffold.sh" --force
```

Only report if files were missing or created. If all present, say nothing
and proceed to step 5.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=scaffold status=running log.info="Scaffold complete"
```

---

## 5. Phase: strategy

The scaffold is complete but no strategy spec was found.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=strategy status=running log.info="Looking for strategy specification..."
```

First, check for available strategy directories (already in place from scaffold):

```bash
ls strategies/*/strategy.md 2>/dev/null
```

**You MUST use the `AskUserQuestion` tool** to present the strategy choice.
Build the options list dynamically based on discovered strategies:

- For each strategy directory found (has `strategy.md` and `main.ts`), add an
  option with label `Use strategy: <name>` and description from the first line
  of the strategy.md file. Mention it includes ready-to-run code.
- Always add option: label `Run /discover`, description `Scan prediction markets,
  identify opportunities, and generate a strategy spec automatically`.
- Always add option: label `Provide a spec`, description `Point to an existing
  strategy document or describe your strategy`.

Use header `Strategy` and question `Which strategy approach do you want to use?`.
Do NOT print the options as markdown text — always use `AskUserQuestion`.

**If the user chooses a strategy:**

The strategy directory is already at `strategies/<name>/` from the scaffold step —
no file copying is needed. Generate a thin entry point that imports the selected
strategy's main module and starts the runner.

1. Copy the strategy spec to docs:

```bash
mkdir -p docs
cp strategies/<name>/strategy.md docs/strategy-<name>.md
```

2. Copy the strategy's pre-built entry point to `src/main.ts` and rewrite
   its relative imports for the new location. The template at
   `strategies/<name>/entry.ts` uses `"../../*.js"` (two levels up to project
   root) and `"./*.js"` (sibling files); from `src/main.ts` those need to
   become `"../*.js"` and `"../strategies/<name>/*.js"` respectively.

   Use this deterministic two-step transform — do **not** rely on the agent
   to figure out path rewrites on the fly:

```bash
mkdir -p src
NAME="<name>"  # the strategy you selected, e.g. "trade-momentum"
sed -e 's|"\.\./\.\./|"\.\./|g' \
    -e "s|\"\\./|\"\\.\\./strategies/${NAME}/|g" \
    "strategies/${NAME}/entry.ts" > src/main.ts
```

   The first expression rewrites `"../../"` → `"../"` (project-root paths
   shift by one level when moving from `strategies/<name>/` to `src/`).
   The second rewrites `"./"` → `"../strategies/<name>/"` (sibling
   imports become explicit cross-directory imports).

3. Copy the strategy's flow definition for the TUI pipeline diagram:

```bash
cp strategies/<name>/flow.json .canon/flow.json 2>/dev/null || true
```

4. Verify the entry point compiles:

```bash
pnpm exec tsc --noEmit &>/dev/null
```

Read the strategy spec and print a brief summary (market, archetype, edge thesis).

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    log.info="Strategy <name> selected — entry point generated"
```

**If the user chooses /discover:**

Execute the `/discover` procedure inline:

1. As market-analyst, research available prediction markets using web search
   and the Polymarket API documentation.
2. Scan for opportunities (price movements, volume spikes, thin liquidity, resolution events).
3. Select the top opportunity by edge size, liquidity, resolution clarity, and capital efficiency.
4. As strategy-architect, design a strategy for the selected opportunity:
   - Select strategy archetype (from strategy-patterns skill)
   - Design entry/exit signal logic
   - Define risk parameters (position size ≤5%, stop-loss, circuit breakers)
   - Define backtest success criteria (win rate >55%, profit factor >1.2,
     max drawdown <15%, min 30 trades)

Write the strategy spec to `docs/strategy-<name>.md`.

Load agents: market-analyst, strategy-architect.
Load skills: prediction-markets, polymarket, strategy-patterns, risk-management.

**If the user provides a spec:**

Read the provided document. Validate it contains:
- Target market(s)
- Strategy archetype or approach
- Entry/exit logic
- Risk parameters

If anything is missing, ask the user to clarify before proceeding.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=strategy status=running log.info="Strategy spec ready"
```

Proceed to step 6.

---

## 6. Phase: develop

A strategy spec exists. Build the strategy using the orchestrator — an automated
engine that spawns parallel workers in isolated worktrees, reviews each item,
and iterates until all checks pass.

Write state update:

```bash
TUI_WRITE="${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/terminal-ui-write.sh"
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=develop status=running log.info="Starting development..."
```

### 6a. Set up exec plan

Determine the strategy slug from the spec filename (e.g. `strategy-nba-momentum.md` → `nba-momentum`).

```bash
SLUG="$(date +%Y%m%d)-<strategy-slug>"
mkdir -p "docs/exec-plans/active/${SLUG}"
```

**If a template bundle was used (step 5):** The bundle includes a pre-filled plan.
Copy it directly — replace `{{DATE}}` with today's date:

```bash
sed "s/{{DATE}}/$(date +%Y-%m-%d)/" ".canon/templates/<name>/plan.md" \
  > "docs/exec-plans/active/${SLUG}/plan.md"
```

The pre-filled plan has bootstrapped items already checked off. Only the
decision-logic items (config, signals, risk, strategy, test assertions)
remain unchecked — those are what you will build now.

**If /discover or user-provided spec:** Create a plan with the items needed
based on the strategy spec. Write to `docs/exec-plans/active/${SLUG}/plan.md`.

Write state update:

```bash
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=develop status=running log.info="Exec plan generated: ${SLUG}"
```

### 6b. Build the strategy

Read the exec plan at `docs/exec-plans/active/${SLUG}/plan.md`. For each
unchecked item, implement it directly:

1. Read the item description
2. Write the code (create files, implement logic)
3. Write state update for each item completed:
   ```bash
   [[ -f "${TUI_WRITE}" ]] && \
     bash "${TUI_WRITE}" .canon/state.json \
       phase=develop status=running log.info="Done: <item description>"
   ```
4. Mark the item as checked in the plan: `[x]`
5. Move to the next unchecked item

After all items are done, run the success criteria checks:

```bash
pnpm exec tsc --noEmit
pnpm exec oxlint src/
pnpm exec vitest run
```

If checks fail, fix the issues and re-run. Iterate until all pass.

When all checks pass:

```bash
[[ -f "${TUI_WRITE}" ]] && \
  bash "${TUI_WRITE}" .canon/state.json \
    phase=develop status=complete log.info="Strategy built — all checks pass"
```

Proceed to step 7.

---

## 7. Phase: run

All checks pass and QA is approved. The strategy is ready for execution
in **dry-run mode**. This is the validation step before going live —
never auto-runs real orders.

Run this **single** bash block to verify the entry point exists, launch the runner, and confirm:

```bash
set -euo pipefail

if [[ ! -f "src/main.ts" ]]; then
  echo "NO_ENTRY"
  exit 0
fi

# Create empty .env if missing (some strategies run without auth)
touch .env

bash "${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/canon-runner.sh" &
RUNNER_PID=$!
disown
sleep 2

if kill -0 "${RUNNER_PID}" 2>/dev/null; then
  echo "OK ${RUNNER_PID}"
else
  echo "FAIL"
  tail -5 .canon/execution/runner.log 2>/dev/null
fi
```

Handle the output:
- `NO_ENTRY` → tell the user: `No entry point at src/main.ts — run strategy selection first (phase 5).`
- `OK <pid>` → print: `Runner started (PID <pid>, dry-run). Stop: kill <pid>. Switch to live: /canon-start --live`
- `FAIL` → print the log tail, nothing else.

---

## 8. Phase: live

Reached only when the user invoked `/canon-start --live`. Drives the
project from "dry-run validated" to "live trading" by collecting a
native-USDC deposit at the EOA, running the gasless onboarding chain
that pulls funds into the Polymarket Safe (V1+V2 approvals + builder
creds + EIP-2612 permit + Uniswap swap + Onramp wrap), and launching
`canon-runner.sh --live`.

Run this **single** bash block. Do not split into multiple tool calls —
the script is the deterministic spine, this command stays a thin
wrapper:

```bash
bash "${DEGA_CORE_HOME:-${HOME}/.degacore}/scripts/canon-live-readiness.sh"
```

Behaviour:
- The script writes its own state into `.canon/state.json` at every
  transition (`deposit-pending` → `funds-detected` → `onboarding` →
  `ready` → `running`). The TUI surfaces those.
- If `src/main.ts` does not exist, the script exits non-zero with a
  message telling the user to run `/canon-start` (no flag) first. Do
  not auto-fall-back to the build phases — `--live` is for the
  transition, never for the initial scaffold.
- If the wallet is already onboarded (Safe deployed, V1+V2 approvals
  set, creds derivable, collateral > 0), the script skips deposit
  polling and goes straight to launching the live runner. Re-running
  `/canon-start --live` is therefore safe and idempotent.
- Deposit polling defaults to 10s cadence with a 30-min timeout
  (`CANON_LIVE_POLL_SECS` and `CANON_LIVE_TIMEOUT_SECS` override).
- On timeout, the script writes `phase=live, status=timeout` so the
  TUI keeps the EOA address visible. Re-running resumes polling.

When the script exits 0, print:

`Live runner started. PID and live status are in .canon/state.json. Stop: kill <pid>.`

When the script exits non-zero, print the `error` field from
`.canon/state.json` (if present) and stop. Do not retry automatically;
let the operator inspect and decide.

---

## Graceful degradation

This command expects to be launched via `./canon.sh`, which uses either the
Canon TUI (`canon run`) or tmux as a fallback.
Dashboard state writes degrade gracefully:

| Component | If missing | Behavior |
|-----------|-----------|----------|
| Neither Canon TUI nor tmux detected | Stop with message | User told to run `./canon.sh` first |
| `$DEGA_CORE_HOME/scripts/terminal-ui-write.sh` | Skip state file writes | No dashboard updates, workflow still runs |

**Canon TUI detection:** The session is valid if ANY of these are true:
- `$TMUX` is set (tmux fallback)
- `$CANON_TUI` is set (Canon TUI / canon-tui)
- `.canon/state.json` exists and was updated within the last 5 minutes (TUI wrote init state)

Every `terminal-ui-write.sh` call in this command is already guarded with
`[[ -f "${TUI_WRITE}" ]] &&`. If the script
does not exist, the call is skipped silently — no error, no repeated warnings.

---

## Completion criteria

- TUI environment verified at entry — stops if not inside Canon TUI or tmux
- Phase detection correctly identifies the project's current state
- Each phase delegates to the right sub-command logic (canon-scaffold.sh, discover, develop)
- State file is updated at each phase transition (when terminal-ui-write.sh is available)
- Graceful degradation: dashboard writes skipped silently when terminal-ui-write.sh is missing
- User is guided through the full pipeline with minimal questions
