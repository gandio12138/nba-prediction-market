---
name: polymarket
description: Polymarket-specific knowledge — API, fees, resolution, mechanics
version: 1.0.0
domain: platform
requires: [prediction-markets]
tools: [canon-cli]
---

# Polymarket Platform Knowledge

## Context
Load this skill when building strategies that trade on Polymarket specifically.
Polymarket has platform-specific mechanics that affect strategy design.

## Core Knowledge

### Platform Mechanics
- Blockchain-based (Polygon) — trades are on-chain transactions
- CLOB (Central Limit Order Book) model via CTF Exchange (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) and NegRisk CTF Exchange (`0xC5d563A36AE78145C45a50134d48A1215220f80a`)
- **Collateral is USDC.e (bridged, `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — NOT native USDC (`0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`).** Users who fund with native USDC / USDT / excess POL must convert before trading; use `canon-cli onboard`.
- Minimum order size: 5 shares. Price is a probability in `[0, 1]`.
- Conditional tokens: ERC-1155 tokens representing outcome shares

### Fee Structure
- No trading fees for makers (limit orders that add liquidity)
- Taker fee: ~1-2% (market orders that remove liquidity)
- Strategy implication: Prefer limit orders to avoid taker fees
- Withdrawal fees: Polygon gas costs (minimal)

### API Access (via pmxt)
- REST API for market data, order placement, position tracking
- WebSocket for real-time order book and trade updates
- Rate limits: Respect rate limits to avoid API bans
- Authentication: EOA-based by default. Canon auto-generates a project-local burner via `canon-cli wallet ensure` (stored at `.canon/wallet.env`, mode 0600) during `/canon-start`. `POLYMARKET_PRIVATE_KEY` env var still wins when set (CI / bring-your-own-wallet). L2 API credentials are derived automatically from the EOA's L1 signature on first use. For order signing, `signatureType: "eoa"` (type 0). Gnosis Safe mode (type 2) is supported by pmxtjs but not wired into Canon yet.
- Order-placement requires USDC.e approval to CTFExchange / NegRiskCTFExchange / NegRiskAdapter on the EOA. This is a one-time setup per wallet.

### Resolution Process
- Oracle-based resolution (UMA optimistic oracle)
- Resolution proposals can be disputed (24-48 hour window)
- Edge case: Disputed resolutions can delay payouts significantly
- "N/A" resolution possible — returns all shares to $0.50

### Market Categories (relevant to NBA Playoffs hackathon)
- Sports: Individual games, series outcomes, player props, MVP
- Politics: Elections, policy outcomes, appointments
- Crypto: Price targets, protocol events, regulatory actions
- Current events: Science, entertainment, weather

## Decision Frameworks

### Order Type Selection
- Limit order: When you have time and want to avoid fees → Use for most trades
- Market order: When speed matters (breaking news, rapid price movement) → Accept taker fee
- GTC (Good Till Cancelled): Default for strategies that wait for fills
- FOK (Fill or Kill): When partial fills would unbalance your position

### Monitoring Positions
- Check positions via `canon-cli position list`
- Monitor P&L via `canon-cli position list` (includes PnL summary)
- List currently-open orders via `canon-cli order open`
- List trade history via `canon-cli order trades`
- Watch for resolution approaching — exit or hold decision
- Set alerts for price movements >10% (potential information event)

### Wallet Onboarding
When a user wallet has no tradeable USDC.e but has other assets:
- Native USDC → swap to USDC.e (Uniswap v3, 0.01% pool)
- USDT → swap to USDC.e (0.01% / 0.05%)
- Excess POL → swap to USDC.e (0.3%), keeping a gas reserve
Run `canon-cli onboard` (dry-run) and `canon-cli onboard --execute` (live).
Single-asset: `canon-cli onboard --asset POL --amount 1 --execute`.

## Common Mistakes
- **Funding with native USDC:** Polymarket is USDC.e-only. Users who send `0x3c499c...` USDC see `balance: 0` on Polymarket; fix with `canon-cli onboard`.
- **Ignoring gas costs:** Polygon gas is low but not zero — frequent small trades add up. Keep ~1 POL reserve.
- **Market order slippage:** Large market orders in thin books get terrible fills.
- **Missing resolution disputes:** Disputed resolutions can lock capital for weeks.
- **Order below 5-share minimum:** rejected by the exchange. Bump `size` if price is low.
- **API rate limiting:** Aggressive polling gets your key throttled — use WebSocket for live data.
