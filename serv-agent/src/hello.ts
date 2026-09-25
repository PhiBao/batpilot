import dotenv from 'dotenv'
dotenv.config()

import { Agent, run } from '@openserv-labs/sdk'
import { provision, triggers, PlatformClient } from '@openserv-labs/client'
import { z } from 'zod'

const agent = new Agent({
  systemPrompt: 'You are the Batpilot gate-test agent. Answer briefly and exactly.',
})

agent.addCapability({
  name: 'ping_batpilot',
  description: 'Replies with a status proof string for the Batpilot kill-or-go gate test.',
  inputSchema: z.object({ word: z.string().describe('Echo word') }),
  async run({ args }) {
    return `batpilot-gate:${args.word}`
  },
})

async function main() {
  const result = await provision({
    agent: {
      instance: agent,
      name: 'batpilot-gate',
      description: 'Kill-or-go gate test: provision, webhook, runnable capability round-trip.',
      // $1 credit discipline: cheapest catalog model for all platform LLM use.
      model_parameters: { model: 'gpt-5-nano', verbosity: 'low', reasoning_effort: 'low' },
    },
    workflow: {
      name: 'Batpilot Gate Test',
      goal: 'Verify the Batpilot agent can provision on the platform, receive a webhook task, execute its runnable capability, and return the result end to end.',
      trigger: triggers.webhook({ waitForCompletion: true, timeout: 600 }),
      task: { description: 'Reply via ping_batpilot' },
    },
  })
  console.log('GATE agentId:', result.agentId, 'workflowId:', result.workflowId)

  // Start agent server (tunnel) without blocking the fire step.
  run(agent)
  await new Promise((r) => setTimeout(r, 10000))

  dotenv.config({ override: true })
  const client = new PlatformClient()
  await client.authenticate(process.env.WALLET_PRIVATE_KEY)
  const out = await client.triggers.fireWebhook({
    workflowId: result.workflowId,
    input: { word: 'hello-gate' },
  })
  console.log('GATE_WEBHOOK_RESULT:', JSON.stringify(out).slice(0, 600))
  process.exit(0)
}

main().catch((e) => {
  console.error('GATE_FAILED:', e?.message ?? e)
  process.exit(1)
})
