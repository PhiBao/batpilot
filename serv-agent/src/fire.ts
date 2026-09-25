import dotenv from 'dotenv'
dotenv.config()
import { PlatformClient } from '@openserv-labs/client'

const client = new PlatformClient()
await client.authenticate(process.env.WALLET_PRIVATE_KEY)
const input = process.argv[2] ?? 'Buy $8 of NVDA every 15 minutes, stop me out at minus 8 percent'
console.log('FIRING:', input)
const out = await client.triggers.fireWebhook({ workflowId: 13912, input: { input } })
console.log('ACK:', JSON.stringify(out).slice(0, 200))
// Poll for the completed task output (up to ~6 min).
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 10000))
  const tasks = (await client.tasks.list({ workflowId: 13912 })) as any[]
  const t = tasks[0]
  const val = t?.output?.value ?? t?.latest_task_execution_record?.output?.value
  console.log(`poll ${i}: status=${t?.status}`)
  if (t?.status === 'done' && val) {
    console.log('TASK_OUTPUT:', String(val).slice(0, 1200))
    process.exit(0)
  }
  if (t?.status === 'failed' || t?.status === 'error') {
    console.log('TASK_FAILED:', JSON.stringify(t).slice(0, 800))
    process.exit(1)
  }
}
console.log('POLL_TIMEOUT')
process.exit(2)
