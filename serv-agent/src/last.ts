import dotenv from 'dotenv'
dotenv.config()
import { PlatformClient } from '@openserv-labs/client'

const client = new PlatformClient()
await client.authenticate(process.env.WALLET_PRIVATE_KEY)
const tasks = (await client.tasks.list({ workflowId: 13912 })) as any[]
const t = tasks[0]
console.log('status:', t?.status)
console.log('OUTPUT:', JSON.stringify(t?.output ?? t?.latest_task_execution_record?.output).slice(0, 1500))
process.exit(0)
