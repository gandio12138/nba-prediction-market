# Orchestrator Skill

The orchestrator is the automated execution engine for Canon development.
It takes an exec plan and drives it to completion using parallel workers,
per-item review, and iterative refinement.

## How it works

1. **Plan** — an exec plan at `docs/exec-plans/active/<slug>/plan.md` defines
   work items with dependency annotations `(deps: N)`.
2. **Workers** — the orchestrator spawns one agent per ready item, each in its
   own git worktree for isolation.
3. **Review** — after a worker completes, a reviewer agent evaluates the work
   against success criteria in `dega-core.yaml`.
4. **Iterate** — if the reviewer says REVISE, the worker retries (up to
   `max_iterations`). If SHIP, the item is done.
5. **Final review** — when all items are done, a final review runs across the
   full changeset. If it passes, the plan is complete.

## Entry point

```bash
bash "${DEGA_CORE_HOME}/scripts/orch-run.sh" "<slug>"
```

This creates a tmux session (`orch-<slug>`) with the engine and a dashboard.
State is written to `.orchestrator/plans/<slug>/state.json` and the master
registry at `.orchestrator/master.json`.

## State format

```json
{
  "version": 1,
  "plan": "<slug>",
  "status": "running",
  "items": [
    {
      "id": 1,
      "description": "...",
      "deps": [],
      "status": "done",
      "iteration": 2,
      "maxIterations": 5,
      "lastResult": "SHIP",
      "reviewStatus": "passed"
    }
  ]
}
```

Item statuses: `queued → ready → running → review → done | failed | blocked`

## Key behaviors

- Items with no unmet deps start in parallel automatically.
- Each worker gets its own worktree — no file conflicts between workers.
- The engine polls for completion and spawns new workers as deps are met.
- GitHub Issue sync updates the tracking issue with progress (if configured).
- On completion, the orchestrator creates a PR with all changes.

## When to use

Use the orchestrator for any multi-step development work: building a strategy,
implementing features, fixing a set of bugs. It replaces manual iteration by
automating the build-test-review cycle.

## Monitoring

- **tmux session**: `tmux attach -t orch-<slug>`
- **State file**: `.orchestrator/plans/<slug>/state.json`
- **Master dashboard**: `.orchestrator/master.json`
- **Canon TUI**: shows Builder section when orchestrator is running
