# Batpilot testnet concierge — 5-minute user onboarding

Goal: 10 funded plans from 8+ independent wallets. You (the founder) run this
call/chat; the user only needs Robinhood Wallet (or any EVM wallet) + 5 minutes.

## Before the call (founder, 2 min)

1. Open the testnet app: <VERCEL_TESTNET_URL>.
2. Have the RHC testnet faucet ready: https://faucet.testnet.chain.robinhood.com
   (drips 0.01 ETH + test stock tokens per 24h).

## On the call (user does everything, you narrate)

1. **Connect** wallet → switch to Robinhood Testnet (chain id 46630;
   RPC `https://rpc.testnet.chain.robinhood.com`).
2. **Faucet**: claim ETH + TSLA at the faucet link above.
3. **Mint demo USDG**: on the app, hit "mint test USDG" (faucet button) —
   confirms in ~5s.
4. **Launch plan**: NVDA · $50/fill · every 1 min · stop-loss 8% · take-profit
   20% · fund $1,000 → approve → create → fund (3 clicks).
5. **Watch**: within ~1 minute the keeper fires the first fill — the plan card
   shows stock held + avg entry, and the trail shows the FILL event.
6. **The wow moment**: ask them to watch the next fill get *refused* (stale-feed
   simulation) or trigger protection — show the `GuardRejected` / `Protected`
   rows and the tx links.

## After (30 s)

- Ask: "Would you run $50/week of real money through this? What stops you?"
- Log: wallet, plan id, feedback quote. These quotes go in the submission.

## FAQ for skeptics

- "Is this real money?" No — testnet. Mainnet contracts are deployed and
  verified; real funds come after audit.
- "Who holds my money?" Nobody — the vault contract holds plan funds and only
  your wallet can cancel/withdraw.
- "What if the keeper dies?" Anyone (including you, one click in the app) can
  trigger execution. The keeper has no power over funds.
