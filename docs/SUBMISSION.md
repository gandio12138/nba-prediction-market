# DoraHacks Submission Notes

## Current Status

This repo is ready for the code and documentation portion of the DoraHacks submission package: source code, setup instructions, automation flow documentation, validation commands, and a demo-video script. The remaining required artifact is the uploaded 3-5 minute demo video.

DEGA clarified on 2026-05-14 that registration is purely on DoraHacks. There is
no separate Canon project, strategy, wallet, or DEGA Rank registration step for
dry-run submissions. If the automation is run live, submit the Polymarket wallet
address and automation logs from `.canon/execution/`; if it is not run live, the
public GitHub repo plus 3-5 minute demo video are the submission package.

## Hackathon Requirements Tracked

Based on the official DoraHacks NBA Playoffs Prediction Market Hackathon page:

- Project description covering strategy approach and intended automation behavior
- Public GitHub source code
- Documentation with setup instructions and an about section describing the automation flow
- 3-5 minute demo video

Judging criteria:

- Innovation and Creativity: 25%
- Technical Execution and Design: 30%
- Real World Utility and Impact: 30%
- Presentation and Demo: 15%

Live trading is not strictly required to submit. However, Real World Utility is
evaluated on actual live performance against Polymarket markets, so a dry-run
only submission will not have live P&L evidence for that 30% scoring segment.
If running live, plan for the May 31-June 19 window. There is no minimum
funding requirement.

Timeline:

- Submission opens: 2026-05-04 14:00
- Deadline: 2026-06-01 13:59
- Registration closes: 2026-05-31
- Winners announced: 2026-06-23

Prize:

- Total prize pool: $1,000 USD stablecoin
- First place: $1,000, awarded to the best performer by highest profit percentage

Sources to re-check before final submission:

- Official DoraHacks page: https://dorahacks.io/hackathon/nba-prediction-market/detail
- DEGA Canon planning issue: https://github.com/DEGAorg/claude-code-config/issues/75

## Submission Checklist

- [x] Canon scaffold initialized in this repo
- [x] TRADE-02 NBA momentum scanner wired to `src/main.ts`
- [x] Default dry-run mode documented
- [x] Live-mode safety gates documented
- [x] Setup commands documented in `README.md`
- [x] Environment variable reference added in `.env.example`
- [x] Demo video script drafted in `docs/DEMO_SCRIPT.md`
- [x] Typecheck/lint/test commands available through `pnpm run check`
- [x] Public GitHub remote created and pushed: https://github.com/gandio12138/nba-prediction-market
- [ ] Demo video recorded and uploaded
- [ ] DoraHacks project form filled with final GitHub/video URLs
- [ ] Optional live package, if running live: wallet address plus
      `.canon/execution/` automation logs

Note: `.canon/execution/` is ignored by git. If live trading is enabled, review
the JSONL logs and attach the relevant files separately in the DoraHacks
submission or project notes.

## Project Description Draft

NBA Prediction Market Automation is a DEGA Canon TypeScript strategy for the NBA Playoffs Prediction Market Hackathon. It runs a TRADE-02 momentum scanner over Polymarket NBA markets, looking for low-probability YES outcomes that are repricing upward on confirming volume and open-interest signals. The automation keeps dry-run mode as the default, emits structured JSONL decision logs, and only submits real CLOB GTC limit orders when explicitly started with `--live` after onboarding, allowance, auth, and max-order safety checks pass.

## BUIDL Submission Copy

### Project Description

NBA Prediction Market Automation is a Canon-based TypeScript automation for the DEGA NBA Playoffs Prediction Market Hackathon. The project implements a TRADE-02 momentum strategy for Polymarket NBA markets: it searches for low-probability YES outcomes that are starting to trend upward, confirms the move with volume and technical indicators, applies risk gates, and logs structured dry-run decisions by default.

The intended behavior is to help operators monitor NBA prediction markets for momentum-driven opportunities while keeping capital safety explicit. Dry-run mode is the default so reviewers can run the full scanner without placing trades. Live execution is opt-in through `--live` and is protected by wallet onboarding checks, CLOB auth checks, USDC allowance checks, position sizing, and a per-run `MAX_ORDERS` cap.

### About / Automation Flow

The automation starts from `src/main.ts`. It loads the DEGA Canon strategy framework, starts the TRADE-02 runner, and polls Polymarket market data using `MOMENTUM_QUERY=NBA`. Each binary market snapshot is normalized into the strategy input format with condition ID, question text, YES/NO token IDs, midpoint price, volume, open interest, and time-to-close data.

The scanner keeps rolling history per market and computes confluence signals: price delta, volume percentile, RSI, MACD crossover, and open-interest trend. A candidate must pass the entry price band, gross-edge threshold, signal TTL, time-to-close guard, manipulation guard, concurrent-position limit, and fractional-Kelly sizing checks. In dry-run mode, the runner writes logs and prints scan decisions. In live mode, approved signals are routed to the Canon/pmxt executor as GTC CLOB limit orders.

### Silent Demo Video Explanation

The demo video has no voiceover, so this text explains what is shown:

1. The video opens the public GitHub repository to show the source code, README, setup instructions, and automation flow documentation.
2. It shows the active git branch and project state, confirming the implementation is on the Canon strategy branch.
3. It runs `pnpm run check`, which executes TypeScript typechecking, oxlint, and the Vitest suite. This demonstrates that the project compiles, passes linting, and has automated test coverage.
4. It starts the pmxt sidecar with `pnpm exec pmxt-ensure-server`, which is required by the Canon/Polymarket market-data and execution adapter path.
5. It runs `POLL_INTERVAL_MS=5000 MOMENTUM_QUERY=NBA pnpm run start:dry-run`. The terminal shows the dry-run bankroll banner, the TRADE-02 scanner startup line, and repeated `SCAN` cycles.
6. The video stops the scanner after a few cycles. No real trades are placed because the demo uses the default dry-run mode and does not pass `--live`.
7. The safety model is documented in the README and code: live execution requires explicit opt-in, preflight checks, wallet onboarding, CLOB credentials, USDC allowance readiness, and a `MAX_ORDERS` limit.

GitHub repository: https://github.com/gandio12138/nba-prediction-market

## About / Automation Flow Draft

The automation polls Polymarket binary markets with `MOMENTUM_QUERY=NBA`, converts each result into a strategy snapshot, and maintains rolling per-market history. The signal layer computes price delta, volume percentile, RSI, MACD crossover, and open-interest trend. A trade candidate must clear a confluence gate, entry-price band, gross-edge threshold, signal TTL, time-to-close guard, and manipulation checks. Position sizing uses fractional Kelly with exposure caps. In dry-run mode, the runner logs decisions without risking funds. In live mode, the same pipeline routes approved signals through the Canon/pmxt live executor with a per-run `MAX_ORDERS` cap.

## Setup Instructions Draft

```bash
pnpm install
pnpm exec pmxt-ensure-server
POLL_INTERVAL_MS=5000 MOMENTUM_QUERY=NBA pnpm run start:dry-run
```

Validation:

```bash
pnpm run check
```

Live mode is optional. It is not required for DoraHacks submission, but live
performance affects the Real World Utility scoring segment. If you run live,
use an onboarded Polymarket wallet funded at whatever level you are comfortable
with and keep automation logs from `.canon/execution/` for submission:

```bash
pnpm run start -- --live
```

Never commit `.env` or `.canon/wallet.env`.

## Demo Evidence To Capture

- `git branch --show-current` showing `feat/trade-momentum-scanner`
- `pnpm run check` passing
- `pnpm exec pmxt-ensure-server` before the scanner starts
- `POLL_INTERVAL_MS=5000 MOMENTUM_QUERY=NBA pnpm run start:dry-run` producing the bankroll banner and scan logs
- Brief walkthrough of `src/main.ts`, `docs/strategy-trade-momentum.md`, and live-mode safety gates
