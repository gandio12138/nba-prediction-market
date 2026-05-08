# Quick Dev

@description Streamlined build for small, well-scoped changes — bug fixes, parameter tweaks, minor features.

Load agent: dev.
Load skills: canon-conventions.

Use this workflow for small, clearly-scoped changes. For new strategies or major
features, use /discover and /develop instead. No formal QA or risk review required.

## When to use
- Bug fix in existing strategy logic
- Parameter adjustment (thresholds, limits, timeframes)
- Minor feature addition to an existing strategy
- Refactor that does not change behavior

## When NOT to use
- New strategy from scratch → use /discover then /develop
- Changes to RiskInterface hard limits → requires risk-analyst review
- Arena registration or re-registration → use /register
- Changes affecting more than 2-3 files → use /develop for full pipeline

## 1. Implement

Understand the change request fully before writing any code.

Apply the change following Canon conventions (domain layering, error messages).

Run after implementation:

```
npm test && npm run lint && npx tsc --noEmit
```

## 2. Verify

Review your changes:
- Does the change do exactly what was requested and nothing more?
- Do all tests pass?
- Is lint clean?
- Are types valid?
- Did you inadvertently modify anything outside the scope of the request?

If tests are failing, iterate on the fix until they pass. Do not declare done
with failing tests.

## Completion criteria

- Change implemented and scoped to the request
- Tests pass (`npm test`)
- Lint clean (`npm run lint`)
- Types valid (`npx tsc --noEmit`)
