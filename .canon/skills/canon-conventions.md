---
name: canon-conventions
description: Canon project conventions, idioms, and coding standards
version: 1.0.0
domain: conventions
requires: []
tools: []
---

# Canon Conventions

## Context
Load this skill for any Canon development work. These are Canon's
non-negotiable coding standards.

## Core Knowledge

### Domain Layering (Rigid)
All Canon code follows strict domain layering:
Types → Config → Repo → Service → Runtime → UI

- Types: Pure type definitions, no logic
- Config: Constants, environment, feature flags
- Repo: Data access (LanceDB, API clients, file I/O)
- Service: Business logic (strategy evaluation, risk checks, Ralph Loop)
- Runtime: Process management (agent lifecycle, hook execution)
- UI: Presentation (Arena dashboard, strategy cards)

Each layer may only import from layers to its left. Never skip layers.

### Strategy Structure
All strategies implement two interfaces:
- `TradeSignal` — Output: what to trade, direction, size, confidence
- `RiskInterface` — Validation: position limits, exposure checks, circuit breakers

### File Organization
- `src/strategy.ts` — Main strategy logic
- `src/types/TradeSignal.ts` — Output interface
- `src/types/RiskInterface.ts` — Risk validation interface
- `.canon/dega-core.yaml` — Ralph Loop configuration
- `AGENTS.md` — Agent entry point

### Error Messages (Agent-Oriented)
All error messages include three parts:
1. **What** happened (the error)
2. **Why** it matters (the consequence)
3. **How** to fix it (the remediation)

Example: "Position size exceeds 5% limit (what). This violates risk management
rules and could cause catastrophic loss (why). Reduce position size to <5% of
portfolio value or adjust risk parameters in .canon/dega-core.yaml (how)."

### Three Non-Negotiable Constraints
1. "If it's not in the repo, it doesn't exist"
2. Favor boring technology
3. Rigid architecture early (enforce mechanically, not culturally)
