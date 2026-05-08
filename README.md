# NBA Prediction Market Automation

> DEGA Canon automation for NBA Playoffs prediction markets: a TypeScript TRADE-02 momentum scanner that watches Polymarket NBA markets, emits structured trade decisions, and keeps real order submission behind explicit live-mode safeguards.

## Why This Exists

The hackathon asks for AI-assisted prediction market automations built with DEGA's Canon workflow. This project turns the Canon TypeScript templates into a runnable NBA-focused scanner: it searches Polymarket markets for low-probability outcomes that are repricing upward on volume, then applies risk gates before logging a dry-run decision or, only with `--live`, submitting capped CLOB limit orders.

DEGA Rank / leaderboard registration is intentionally left as a pending final-submission item until confirmed with the official channel.

## Quick Start

Prerequisites:

- Node.js 22+
- pnpm 10+
- DEGA Core / Canon scaffold installed
- pmxt sidecar available through project dependencies

```bash
pnpm install
pnpm exec pmxt-ensure-server
POLL_INTERVAL_MS=5000 MOMENTUM_QUERY=NBA pnpm run start:dry-run
```

The scanner defaults to dry-run mode. Stop it with `Ctrl-C` after a few scan cycles.

Expected startup shape:

```text
BANKROLL=$10000.00 (dry-run default)
START TRADE-02 scanner (dry-run) query=NBA max_orders=3 poll=5000ms
SCAN #1 ...
```

## Canon Workflow

Launch the Canon project workspace:

```bash
./canon.sh
```

If the Canon TUI is unavailable, the script falls back to a tmux session with the agent pane and a state dashboard.

## Automation Flow

1. Fetch binary Polymarket market snapshots using the configured `MOMENTUM_QUERY`.
2. Convert each market into the TRADE-02 snapshot shape with midpoint, liquidity, token IDs, and time-to-close fields.
3. Maintain rolling history per market and compute momentum indicators: price delta, volume percentile, RSI, MACD crossover, and open-interest trend.
4. Require confluence before entry: price band, volume confirmation, gross edge, signal TTL, and manipulation/time-to-close guards.
5. Size positions with fractional Kelly under max exposure and max concurrent-position limits.
6. Emit JSONL execution log entries in dry-run mode; submit GTC CLOB limit orders only when started with `--live`.

Primary entry point: `src/main.ts`

Strategy design: `docs/strategy-trade-momentum.md`

## Safety Model

Dry-run is the default:

```bash
pnpm run start:dry-run
```

Live trading requires an explicit flag:

```bash
pnpm run start -- --live
```

Before live mode starts, the app checks pmxt capabilities, Polymarket onboarding status, CLOB API credentials, USDC collateral, allowance readiness, and wallet auth. `MAX_ORDERS` caps the number of live submissions per process run. Project wallet secrets live in `.canon/wallet.env`, which is ignored by git.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MOMENTUM_QUERY` | `NBA` | Polymarket search query/category used by the scanner. |
| `POLL_INTERVAL_MS` | `30000` | Delay between scan cycles. |
| `MAX_ORDERS` | `3` | Hard cap on live order submissions per process run. |
| `POLYGON_RPC_URL` | `https://polygon.drpc.org` | RPC used for live allowance and onboarding checks. |
| `WALLET_PRIVATE_KEY` | unset | Live-mode signing key; dry-run does not require it. |
| `WALLET_PROXY_ADDRESS` | auto-discovered/persisted when available | Polymarket funder/proxy address used by live trading paths. |

Use `.env.example` as the non-secret reference. Keep real secrets in `.env` or `.canon/wallet.env`.

## Validation

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run check
```

Current local verification completed on 2026-05-08:

- TypeScript compile: pass
- oxlint: pass
- Vitest suite: pass
- Dry-run smoke scan against `MOMENTUM_QUERY=NBA`: pass, stopped after scan cycles

## Hackathon Submission Assets

- Submission checklist and project copy: `docs/SUBMISSION.md`
- Demo video outline: `docs/DEMO_SCRIPT.md`
- Strategy details: `docs/strategy-trade-momentum.md`

Final items still outside this repo:

- Public GitHub repository URL
- 3-5 minute demo video URL
- DEGA Rank / leaderboard registration decision after confirmation
