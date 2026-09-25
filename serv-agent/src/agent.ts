import dotenv from 'dotenv'
dotenv.config()

import { Agent, run } from '@openserv-labs/sdk'
import { provision, triggers } from '@openserv-labs/client'
import { z } from 'zod'
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// ---------- Robinhood Chain mainnet wiring (mirrors frontend/src/config.ts) ----------
const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
} as const
const RPC = 'https://rpc.mainnet.chain.robinhood.com'
const EXPLORER = 'https://robin.etherscan.io'
const VAULT = '0x5071a403633744C016fB31536c5c31A5685eeEA1' as const
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const
const STOCKS: Record<string, { stock: `0x${string}`; feed: `0x${string}` }> = {
  NVDA: {
    stock: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
    feed: '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15',
  },
  TSLA: {
    stock: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
    feed: '0x4A1166a659A55625345e9515b32adECea5547C38',
  },
  AAPL: {
    stock: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
    feed: '0x6B22A786bAa607d76728168703a39Ea9C99f2cD0',
  },
}
const MAX_PLAN_USD = 10 // hard cap per agent-created plan (hackathon safety)
const REASONS = ['OK', 'STALE_FEED', 'PAUSED', 'BAND_BREACH', 'INVALID_PRICE', 'COOLDOWN']

const VAULT_ABI = [
  { type: 'function', name: 'planCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function', name: 'plans', stateMutability: 'view', inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'owner', type: 'address' }, { name: 'stock', type: 'address' },
      { name: 'feed', type: 'address' }, { name: 'amountPerFill', type: 'uint256' },
      { name: 'cadenceSec', type: 'uint256' }, { name: 'stopLossBps', type: 'uint256' },
      { name: 'takeProfitBps', type: 'uint256' }, { name: 'maxStaleSec', type: 'uint256' },
      { name: 'bandBps', type: 'uint256' }, { name: 'slipBps', type: 'uint256' },
      { name: 'usdgBalance', type: 'uint256' }, { name: 'stockBalance', type: 'uint256' },
      { name: 'entryAvg', type: 'uint256' }, { name: 'lastFill', type: 'uint256' },
      { name: 'uiSnapshot', type: 'uint256' }, { name: 'yieldShares', type: 'uint256' },
      { name: 'active', type: 'bool' }, { name: 'paused', type: 'bool' },
      { name: 'cooldownUntil', type: 'uint256' }, { name: 'cooldownSec', type: 'uint256' },
    ],
  },
  {
    type: 'function', name: 'createPlan', stateMutability: 'nonpayable',
    inputs: [
      { name: 'stock', type: 'address' }, { name: 'feed', type: 'address' },
      { name: 'amountPerFill', type: 'uint256' }, { name: 'cadenceSec', type: 'uint256' },
      { name: 'stopLossBps', type: 'uint256' }, { name: 'takeProfitBps', type: 'uint256' },
      { name: 'maxStaleSec', type: 'uint256' }, { name: 'bandBps', type: 'uint256' },
      { name: 'slipBps', type: 'uint256' }, { name: 'cooldownSec', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  { type: 'function', name: 'fundPlan', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  {
    type: 'function', name: 'planEquity', stateMutability: 'view', inputs: [{ name: 'planId', type: 'uint256' }],
    outputs: [{ name: 'usdg', type: 'uint256' }, { name: 'stock', type: 'uint256' }, { name: 'stockValue', type: 'uint256' }, { name: 'yieldValue', type: 'uint256' }],
  },
  { type: 'event', name: 'GuardRejected', inputs: [{ name: 'planId', type: 'uint256', indexed: true }, { name: 'reason', type: 'uint8' }, { name: 'price', type: 'uint256' }, { name: 'feedTs', type: 'uint256' }] },
] as const
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const

function rhcClients() {
  const account = privateKeyToAccount(process.env.RHC_KEY as `0x${string}`)
  const transport = http(RPC, { timeout: 15000 })
  return {
    account,
    pub: createPublicClient({ chain: CHAIN as any, transport }),
    wallet: createWalletClient({ account, chain: CHAIN as any, transport }),
  }
}
const fmtUSD6 = (w: bigint) => '$' + (Number(w) / 1e6).toFixed(2)
const fmtPrice = (p8: bigint) => '$' + (Number(p8) / 1e8).toFixed(2)

// ---------- Agent ----------
const agent = new Agent({
  systemPrompt:
    'You are the Batpilot autopilot agent on Robinhood Chain mainnet. ' +
    'You turn plain-English investing intent into real protected stock plans, and explain everything in plain words. ' +
    'Rules: mainnet only, max $10 per plan, NVDA/TSLA/AAPL only, never move funds except into plans you just created. ' +
    'You never pick stocks yourself — the user states intent, you execute. Be brief.',
})

agent.addCapability({
  name: 'create_plan',
  description:
    'Create a protected stock autopilot plan on Robinhood Chain mainnet from plain English, e.g. "fifty dollars a week into NVDA, stop me out at minus eight percent". Funds it from the agent wallet and returns the plan ID plus transaction links.',
  inputSchema: z.object({ instruction: z.string().describe('The user investing instruction in plain English') }),
  async run({ args, action }) {
    const parsed = await this.generate({
      prompt:
        `Extract a Batpilot plan from this instruction: "${args.instruction}". ` +
        `Return stock symbol (NVDA, TSLA or AAPL only), amountUsd per fill, cadenceMin, stopLossPct, takeProfitPct. ` +
        `Defaults when missing: amountUsd 5, cadenceMin 60, stopLossPct 8, takeProfitPct 20.`,
      outputSchema: z.object({
        stock: z.string(),
        amountUsd: z.number(),
        cadenceMin: z.number(),
        stopLossPct: z.number(),
        takeProfitPct: z.number(),
      }),
      action,
    })
    const sym = parsed.stock.toUpperCase()
    const cfg = STOCKS[sym]
    if (!cfg) return `I can only do NVDA, TSLA or AAPL right now — "${parsed.stock}" is not supported.`
    if (!(parsed.amountUsd > 0) || parsed.amountUsd > MAX_PLAN_USD)
      return `Amount must be between $0 and $${MAX_PLAN_USD} per fill (safety cap). You asked $${parsed.amountUsd}.`
    if (!(parsed.cadenceMin >= 1)) return 'Cadence must be at least 1 minute.'

    const { account, pub, wallet } = rhcClients()
    const amt = parseUnits(String(parsed.amountUsd), 6)
    const fund = amt * 2n // 2 fills of runway (demo scope; top up anytime)
    const bal = (await pub.readContract({
      address: USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
    })) as bigint
    if (bal < fund)
      return `My wallet holds ${fmtUSD6(bal)} — not enough for a $${parsed.amountUsd} plan (needs ~${fmtUSD6(fund)} runway).`

    await wallet.writeContract({
      address: USDG, abi: ERC20_ABI, functionName: 'approve', args: [VAULT, fund],
      account, chain: CHAIN as any,
      nonce: await pub.getTransactionCount({ address: account.address }),
    }).then((h) => pub.waitForTransactionReceipt({ hash: h }))
    // Simulate first to surface revert reasons cleanly.
    const sim = (await pub.simulateContract({
      address: VAULT, abi: VAULT_ABI, functionName: 'createPlan',
      args: [
        cfg.stock, cfg.feed, amt, BigInt(Math.round(parsed.cadenceMin)) * 60n,
        BigInt(Math.round(parsed.stopLossPct * 100)), BigInt(Math.round(parsed.takeProfitPct * 100)),
        3600n, 500n, 200n, 7200n,
      ],
      account: account.address,
    })) as any
    const planId = sim.result as bigint
    const h1 = await wallet.writeContract({
      address: VAULT, abi: VAULT_ABI, functionName: 'createPlan',
      args: [
        cfg.stock, cfg.feed, amt, BigInt(Math.round(parsed.cadenceMin)) * 60n,
        BigInt(Math.round(parsed.stopLossPct * 100)), BigInt(Math.round(parsed.takeProfitPct * 100)),
        3600n, 500n, 200n, 7200n,
      ],
      account, chain: CHAIN as any,
      nonce: await pub.getTransactionCount({ address: account.address }),
    }).then(async (h) => {
      await pub.waitForTransactionReceipt({ hash: h })
      return h
    })
    const h2 = await wallet.writeContract({
      address: VAULT, abi: VAULT_ABI, functionName: 'fundPlan', args: [planId, fund],
      account, chain: CHAIN as any,
      nonce: await pub.getTransactionCount({ address: account.address }),
    })
    return (
      `Done — plan #${planId}: buys $${parsed.amountUsd} ${sym} every ${parsed.cadenceMin} min, ` +
      `sells everything at -${parsed.stopLossPct}% / +${parsed.takeProfitPct}%, then cools down 2h. ` +
      `Funded with ${fmtUSD6(fund)}. First fill lands within ~${parsed.cadenceMin} min. ` +
      `Create: ${EXPLORER}/tx/${h1} Fund: ${EXPLORER}/tx/${h2}`
    )
  },
})

agent.addCapability({
  name: 'plan_status',
  description: 'Report how a Batpilot plan is doing — value, profit and loss, fills, protection — in plain words. Omit plan ID to report the latest plan.',
  inputSchema: z.object({ planId: z.string().optional().describe('Plan ID number, e.g. "0"') }),
  async run({ args }) {
    const { pub } = rhcClients()
    const count = (await pub.readContract({ address: VAULT, abi: VAULT_ABI, functionName: 'planCount' })) as bigint
    if (count === 0n) return 'No plans exist yet.'
    const id = args.planId !== undefined ? BigInt(args.planId) : count - 1n
    const p = (await pub.readContract({
      address: VAULT, abi: VAULT_ABI, functionName: 'plans', args: [id],
    })) as any
    const eq = (await pub.readContract({
      address: VAULT, abi: VAULT_ABI, functionName: 'planEquity', args: [id],
    })) as readonly [bigint, bigint, bigint, bigint]
    const sym = Object.keys(STOCKS).find((k) => STOCKS[k].stock.toLowerCase() === (p[1] as string).toLowerCase()) ?? 'STOCK'
    const total = eq[0] + eq[2] + eq[3]
    const state = !p[16] ? 'closed' : (p[17] as boolean) ? 'paused (corporate action)' : 'active'
    return (
      `Plan #${id} ${sym} is ${state}. Worth ${fmtUSD6(total)} total ` +
      `($${fmtUSD6(eq[0])} cash + stock worth ${fmtUSD6(eq[2])}). ` +
      `Average entry ${p[12] > 0n ? fmtPrice(p[12] as bigint) : 'none yet'}, ` +
      `protection -${Number(p[5]) / 100}% / +${Number(p[6]) / 100}%. ` +
      `${EXPLORER}/address/${VAULT}`
    )
  },
})

agent.addCapability({
  name: 'explain_refusal',
  description: 'Explain why the guard refused a fill or skipped protection for a plan — reads the onchain refusal events and translates the reason code into plain English with the transaction link.',
  inputSchema: z.object({ planId: z.string().describe('Plan ID number, e.g. "0"') }),
  async run({ args }) {
    const { pub } = rhcClients()
    const id = BigInt(args.planId)
    const head = await pub.getBlockNumber()
    const from = head > 200_000n ? head - 200_000n : 0n
    const logs = await pub.getLogs({ address: VAULT, fromBlock: from, toBlock: 'latest' })
    const { decodeEventLog } = await import('viem')
    const refusals: string[] = []
    for (const l of logs.slice(-40)) {
      try {
        const d = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics })
        if (d.eventName === 'GuardRejected' || d.eventName === 'ProtectionSkipped') {
          const a = d.args as any
          if (String(a.planId ?? '') !== String(id)) continue
          const code = Number(a.reason ?? 0)
          const why =
            code === 1 ? 'the price feed was stale, so it refused to trade blind'
            : code === 2 ? 'the plan was paused after a corporate action like a split'
            : code === 3 ? 'the price moved too far too fast versus its band'
            : code === 5 ? 'it was cooling down after a protection sale, sitting out the aftershock'
            : 'protection saw no position or nothing to do'
          const when = a.feedTs ? ` (feed time ${new Date(Number(a.feedTs) * 1000).toLocaleString()})` : ''
          refusals.push(`${d.eventName}: ${why}${when}. Tx: ${EXPLORER}/tx/${l.transactionHash}`)
        }
      } catch { /* skip undecodable */ }
    }
    if (refusals.length === 0)
      return `No refusals on record for plan #${id} in recent blocks — every fill went through cleanly.`
    return `Latest guard decision for plan #${id}: ${refusals[refusals.length - 1]}`
  },
})

async function main() {
  const result = await provision({
    agent: {
      instance: agent,
      name: 'batpilot-autopilot',
      description: 'Turns plain-English investing intent into protected stock autopilot plans on Robinhood Chain, and explains every decision.',
      model_parameters: { model: 'gpt-5-nano', verbosity: 'low', reasoning_effort: 'low' },
    },
    workflow: {
      name: 'Batpilot Autopilot Agent',
      goal: 'Let anyone create and monitor protected tokenized-stock autopilot plans on Robinhood Chain mainnet using plain English: create plans from intent, report status in words, and explain guard refusals with onchain receipts.',
      trigger: triggers.webhook({ waitForCompletion: true, timeout: 600 }),
      task: { description: 'Handle the user investing request' },
    },
  })
  console.log('AGENT agentId:', result.agentId, 'workflowId:', result.workflowId)
  await run(agent)
}

main().catch((e) => {
  console.error('AGENT_FAILED:', e?.message ?? e)
  process.exit(1)
})
