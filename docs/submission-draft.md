# Batpilot — HackQuest submission draft

> Fill into the HackQuest project page. Keep it under their limits; links do the heavy lifting.

## Tagline

Your US stocks, managed while you sleep — recurring buys + stop-loss protection
on tokenized stocks, enforced by a volatility-aware onchain guard, settled in USDG.

## Problem (2–3 sentences)

US market hours are 21:30–04:00 in Singapore — Asian holders sleep through every
session. Tokenized stocks trade 24/7 but are priced 24/5, so naive automation
buys blind into stale weekend prints. There is no onchain DCA and no spot
protection for stock tokens.

## Solution (3–4 sentences)

Batpilot is a non-custodial autopilot on Robinhood Chain: set a plan once (stock,
amount, cadence, stop-loss, take-profit), buys execute on schedule, downside is
capped around the clock, idle USDG earns yield in the Steakhouse vault. A
session-aware guard screens every fill — freshness, volatility-adaptive bands
from feed round history, corporate-action tripwire — and refusals are emitted as
events. The keeper is permissionless and untrusted: contracts decide, anyone may
poke. Everything settles in USDG; every decision is verifiable onchain.

## What is genuinely new

1. First recurring-buy + spot-protection autopilot for tokenized equities
   (only perps have TP/SL today; only a custodial CEX has stock DCA).
2. Volatility-adaptive execution bands computed trustlessly from Chainlink round
   history — bands breathe with the market instead of a static guess.
3. Honest Stylus workload: vol math (ratios + variance + integer sqrt) ported to
   Rust, deployed onchain, benchmarked bit-identical at 41% less gas.
4. The refusal is the proof: `GuardRejected` events make safety visible, and
   protection never acts on stale data.

## Tech

Solidity (OpenZeppelin) vault + guard + vol engine; Stylus/Rust guard;
Uniswap v3 adapter with oracle-anchored slippage; Morpho Earn adapter; viem
keeper; Vite + wagmi app. Deployed on Robinhood testnet (full loop, keeper
filling) and mainnet (real Uniswap + Steakhouse venues), verified on
Blockscout / Sourcify exact-match. 27 Foundry tests + 7 Stylus tests, incl.
mainnet-fork proofs.

## Links

- Repo: https://github.com/PhiBao/batpilot
- App (chain switcher): https://batpilot.vercel.app
- Demo video: <YOUTUBE_URL> (4 min: setup → live fill → refused fill → stop-loss → Earn sweep → fork replay)
- Testnet vault (V2): https://explorer.testnet.chain.robinhood.com/address/0x05295a3c41Ac537a5C1a5E9203ed7f98be86a8bb
- Mainnet vault: https://robin.etherscan.io/address/0xde7b9F01C566A4f8AdcF57CbFC738E5EA2b7Fa0a
- First keeper fill: https://explorer.testnet.chain.robinhood.com/tx/0x6756fd83818f8885e424c7e3f6ccbe3076000ddf9b8b4ee4d82c5d5eec4c70e2

## Roadmap (milestone-ready)

1. First funded mainnet plan + public track record (this week).
2. `oraclePaused()` + staged-multiplier reads; TWAMM execution for large fills.
3. Autopilot baskets, SGD rail, shareable track-record cards.
4. Multisig + audit before scaling external funds; Founder House family-office rails.
