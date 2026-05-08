# DoraHacks Submission Notes

## Current Status

This repo is ready for the non-leaderboard submission package: source code, setup instructions, automation flow documentation, validation commands, and a demo-video script. DEGA Rank / leaderboard registration remains pending confirmation with the official DEGA/DoraHacks channel.

## Hackathon Requirements Tracked

Based on the current public competition listing mirror for the NBA Playoffs Prediction Market Hackathon:

- Project description covering strategy approach and intended automation behavior
- Public GitHub source code
- Documentation with setup instructions and an about section describing the automation flow
- 3-5 minute demo video
- Use of DEGA/Canon AI tooling to build the automation

Judging criteria listed by the public mirror:

- Innovation and Creativity: 25%
- Technical Execution and Design: 30%
- Real World Utility and Impact: 30%
- Presentation and Demo: 15%

Timeline listed by the public mirror:

- Start: 2026-05-04
- End: 2026-06-01
- Registration closes: 2026-05-31

Sources to re-check before final submission:

- Official DoraHacks page: https://dorahacks.io/hackathon/nba-prediction-market/detail
- Public mirror used for cross-checking: https://www.competehub.dev/en/competitions/dorahacksnba-prediction-market
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
- [ ] Public GitHub remote created and pushed
- [ ] Demo video recorded and uploaded
- [ ] DoraHacks project form filled with final GitHub/video URLs
- [ ] DEGA Rank / leaderboard registration confirmed or explicitly marked not required

## Project Description Draft

NBA Prediction Market Automation is a DEGA Canon TypeScript strategy for the NBA Playoffs Prediction Market Hackathon. It runs a TRADE-02 momentum scanner over Polymarket NBA markets, looking for low-probability YES outcomes that are repricing upward on confirming volume and open-interest signals. The automation keeps dry-run mode as the default, emits structured JSONL decision logs, and only submits real CLOB GTC limit orders when explicitly started with `--live` after onboarding, allowance, auth, and max-order safety checks pass.

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

Live mode is optional and requires a funded/onboarded Polymarket wallet:

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
