# Demo Video Script

Target length: 3-5 minutes.

## 0:00-0:30 - Project Framing

Talking points:

- This is an NBA Playoffs prediction-market automation built with DEGA Canon.
- The strategy is TRADE-02 momentum trading on Polymarket NBA markets.
- The default mode is dry-run so reviewers can inspect behavior without risking funds.

Show:

```bash
git branch --show-current
```

## 0:30-1:30 - Architecture Walkthrough

Show:

- `src/main.ts`
- `docs/strategy-trade-momentum.md`
- `.env.example`

Talking points:

- `src/main.ts` wires Canon templates to the trade-momentum runner.
- The scan adapter fetches Polymarket markets with `MOMENTUM_QUERY=NBA`.
- The strategy looks for price movement confirmed by volume, RSI, MACD, and open interest.
- Live mode is opt-in with `--live`; dry-run is the default.

## 1:30-2:45 - Dry-Run Execution

Run:

```bash
pnpm exec pmxt-ensure-server
POLL_INTERVAL_MS=5000 MOMENTUM_QUERY=NBA pnpm run start:dry-run
```

Let two or three scan cycles run, then stop with `Ctrl-C`.

Point out:

- Bankroll banner
- Query and poll interval
- Scan logs
- No live order submission in dry-run mode

## 2:45-3:45 - Risk And Safety

Show the safety gates in `src/main.ts`.

Talking points:

- `--live` runs preflight checks for pmxt capabilities, Polymarket onboarding, auth, collateral, and allowances.
- `MAX_ORDERS` caps live order submission per process run.
- Position sizing uses fractional Kelly and exposure caps.
- Wallet secrets are ignored by git through `.canon/wallet.env` and `.env`.

## 3:45-4:30 - Validation

Run:

```bash
pnpm run check
```

Talking points:

- TypeScript compiles.
- oxlint passes with the same ignore rules used by the local lint command.
- Vitest covers strategy, runner, execution, onboarding, and adapter paths.

## 4:30-5:00 - Submission Close

Show:

- `README.md`
- `docs/SUBMISSION.md`

Talking points:

- The repo includes setup docs, automation flow, submission copy, and demo instructions.
- The public GitHub repo is ready at `https://github.com/gandio12138/nba-prediction-market`.
- The remaining external tasks are uploading this video, submitting the DoraHacks BUIDL form, and completing DEGA Rank registration for live performance tracking.
