# Batpilot SERV Agent

A SERV Reasoning agent that turns plain-English investing intent into protected
tokenized-stock plans on Robinhood Chain mainnet — and explains every decision,
including the fills it refuses, with onchain receipts.

Part of [Batpilot](https://github.com/PhiBao/batpilot) · live in the app's
[Agent page](https://batpilot.vercel.app/agent) · [demo video](https://youtu.be/eNdAm71U4RY).

## How it leverages SERV Reasoning

The agent is built on `@openserv-labs/sdk` as three **runnable capabilities**,
served through the platform rather than as a standalone bot:

| Layer | What we use | Why |
|---|---|---|
| Intent parsing | `this.generate()` with a Zod `outputSchema` | Platform-delegated LLM, no API keys. Natural language → validated plan params (symbol, amount, cadence, stop/take). Exactly one LLM call per creation. |
| Chain execution | Plain `viem` inside `run()` | Reads, approvals, creates, and funds run as code against `BatpilotVault` — deterministic, simulatable, no LLM in the money path. |
| Status & refusal reporting | Code-formatted reads, **zero LLM cost** | `plan_status` and `explain_refusal` never call the model; they format chain state and event logs as sentences. |
| Identity & triggers | `provision()` + `run(agent)` | Platform wallet identity, agent registration (id `4524`), webhook trigger, tunnel serve. `PlatformClient` fires webhooks and polls task completion. |
| Cost control | `model_parameters: { model: 'gpt-5-nano', verbosity: 'low', reasoning_effort: 'low' }` | Cheapest catalog model for all platform-side routing. Total spend is a rounding error on the $1 free credit. |

Design rule: **the LLM only ever parses intent — it never touches money or chain
state.** Every state-changing step is code: affordability check → approve →
simulate → create → fund, with explicit nonces and receipts waited between
transactions. If a capability throws, the platform answers conversationally, so
all outputs are verified onchain, never trusted from chat text.

Two platform API traps, documented so the next builder doesn't trip:
`model_parameters.model` accepts only the platform enum (not inference-catalog
names — `gpt-6-luna` 400s), and it requires `verbosity` + `reasoning_effort`
alongside `model`.

## Capabilities

| Capability | Input | Does |
|---|---|---|
| `create_plan` | `instruction` (plain English) | Parses → validates ($10/plan cap, NVDA/TSLA/AAPL only) → checks wallet runway → approve + create + fund on mainnet → returns plan ID with tx links |
| `plan_status` | `planId?` (defaults to latest) | Reads plans + equity, reports value, P&L, protection levels in words |
| `explain_refusal` | `planId`, `chain` (mainnet/testnet) | Scans `GuardRejected` / `ProtectionSkipped` events, translates the reason code, links the receipt |

## Safety model

- The agent trades from **its own wallet** (`RHC_KEY`), funded with ~$20. The
  deployer key never enters the SERV system.
- Code-enforced **$10 cap per plan**; amounts outside it are refused in words.
- **Local signing** (`account` object, never `account.address` — the latter makes
  viem attempt remote `eth_sendTransaction`, which RHC RPCs reject).
- **Explicit nonces + receipts** between back-to-back transactions (public RPCs
  serve stale nonces otherwise).
- `simulateContract` before every state change to surface revert reasons cleanly.

## Run your own

```bash
cd serv-agent && pnpm install
```

`.env` (never commit — gitignored):

```ini
RHC_KEY=0xYOUR_FRESH_FUNDED_KEY   # ~$20 USDG + gas on Robinhood mainnet
# WALLET_PRIVATE_KEY is auto-created by provision() on first run
```

```bash
npx tsx src/agent.ts   # provision() registers + opens webhook, run() serves via tunnel
```

Talk to it through the OpenServ console or fire the webhook directly
(`src/fire.ts` shows the pattern: `fireWebhook` + poll `tasks.list` until done).
`src/hello.ts` is the original provision round-trip gate test, kept as reference.

## Live proof

- Agent wallet [`0x4f71…9b3`](https://robin.etherscan.io/address/0x4f7163e63C7fd492dEd6846DC38Fef0D8b4dE9b3) owns mainnet plan **#1**:
  [creation](https://robin.etherscan.io/tx/0x2f739ba3cf1aa09fb4daefe49f05b3adf93377896492fd5eab3fb18c5d064114) ·
  [funding](https://robin.etherscan.io/tx/0x0f75e384649694c6197d2b3621ed41a4e7fc87b8ec90574203bdfd7436d56afa) ·
  [first fill](https://robin.etherscan.io/tx/0x0bca36f7052dae21e3709de646a362cb283526dbca388ef7709fef341f452ff0)
- Rehearsed stale-feed refusal, explained verbatim by the agent:
  [tx](https://explorer.testnet.chain.robinhood.com/tx/0x89cd4d378ec71f12cdbfd591674bfd44d3eff2c6ff28c02df00410a5f97a6b4b)
  ($500 untouched, reason `STALE_FEED`).
