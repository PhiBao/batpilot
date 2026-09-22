import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const VAULT_ABI = [
  {
    type: "function",
    name: "planCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "plans",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "stock", type: "address" },
      { name: "feed", type: "address" },
      { name: "amountPerFill", type: "uint256" },
      { name: "cadenceSec", type: "uint256" },
      { name: "stopLossBps", type: "uint256" },
      { name: "takeProfitBps", type: "uint256" },
      { name: "maxStaleSec", type: "uint256" },
      { name: "bandBps", type: "uint256" },
      { name: "usdgBalance", type: "uint256" },
      { name: "stockBalance", type: "uint256" },
      { name: "entryAvg", type: "uint256" },
      { name: "lastFill", type: "uint256" },
      { name: "uiSnapshot", type: "uint256" },
      { name: "yieldShares", type: "uint256" },
      { name: "active", type: "bool" },
      { name: "paused", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "executeDCA",
    stateMutability: "nonpayable",
    inputs: [{ name: "planId", type: "uint256" }],
    outputs: [
      { name: "executed", type: "bool" },
      { name: "reason", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "executeProtection",
    stateMutability: "nonpayable",
    inputs: [{ name: "planId", type: "uint256" }],
    outputs: [{ name: "code", type: "uint8" }],
  },
] as const;

const REASONS = ["allow/due-check", "STALE", "PAUSED", "BAND_BREACH", "INVALID_PRICE"];

type Env = {
  PRIVATE_KEY: string;
  WATCH: string; // "label:chainId:vault:rpc,label:..."
};

function chainDef(chainId: number, rpc: string): Chain {
  return {
    id: chainId,
    name: `batpilot-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
}

async function tickOne(
  label: string,
  chainId: number,
  vault: Address,
  rpc: string,
  account: ReturnType<typeof privateKeyToAccount>
) {
  const chain = chainDef(chainId, rpc);
  const transport = http(rpc, { timeout: 10_000 });
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ account, chain, transport });

  const count = (await pub.readContract({
    address: vault,
    abi: VAULT_ABI,
    functionName: "planCount",
  })) as bigint;

  let active = 0n;
  for (let id = 0n; id < count; id++) {
    let p: readonly unknown[];
    try {
      p = (await pub.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "plans",
        args: [id],
      })) as unknown as readonly unknown[];
    } catch (e: any) {
      console.error(`[${label} plan ${id}] read failed: ${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    if (!p[15]) continue;
    active++;
    const funded = p[9] as bigint;
    const perFill = p[3] as bigint;
    const lastFill = p[12] as bigint;
    const cadence = p[4] as bigint;

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const due = nowSec >= (lastFill as bigint) + (cadence as bigint);

    // --- Scheduled buy (only when due; quiet otherwise) ---
    if (!due) {
      // no log: nothing-to-do is the common case
    } else if (funded < perFill) {
      console.log(
        `[${label} plan ${id}] LOW FUNDS — balance ${(funded as bigint)} < ${perFill} per fill. Top up to resume fills.`
      );
    } else {
      try {
        const res = (await pub.simulateContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "executeDCA",
          args: [id],
          account: account.address,
        })) as any;
        const [executed, reason] = res.result as [boolean, number];
        if (executed) {
          const hash = await wallet.writeContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: "executeDCA",
            args: [id],
            account: account.address,
            chain,
          });
          console.log(`[${label} plan ${id}] DCA fill sent: ${hash}`);
        } else if (reason !== 0) {
          console.log(`[${label} plan ${id}] guard refused fill: ${REASONS[reason] ?? reason} (onchain event emitted)`);
        }
      } catch (e: any) {
        console.error(`[${label} plan ${id}] DCA failed unexpectedly: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
      }
    }

    // --- Protection (always checked — stop-losses can't wait for cadence) ---
    // Only meaningful with a position; silent when flat or calm.
    if ((p[10] as bigint) > 0n) {
      try {
        const res = (await pub.simulateContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "executeProtection",
          args: [id],
          account: account.address,
        })) as any;
        const code = res.result as number;
        if (code === 1 || code === 2) {
          const hash = await wallet.writeContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: "executeProtection",
            args: [id],
            account: account.address,
            chain,
          });
          console.log(`[${label} plan ${id}] PROTECTION fired (${code === 1 ? "STOP" : "TAKE"}): ${hash}`);
        }
      } catch (e: any) {
        console.error(`[${label} plan ${id}] protection check failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
      }
    }
  }
  console.log(`[${label}] tick done, activePlans=${active}`);
}

export default {
  // Manual trigger (dev): GET / triggers one tick. Cron calls scheduled().
  async fetch(req: Request, env: Env): Promise<Response> {
    await runAll(env);
    return new Response("tick complete\n");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAll(env));
  },
};

async function runAll(env: Env) {
  const account = privateKeyToAccount(env.PRIVATE_KEY as Address);
  console.log(`[batpilot-keeper] keeper=${account.address}`);
  for (const entry of env.WATCH.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [label, chainId, vault, ...rpcParts] = entry.split(":");
    const rpc = rpcParts.join(":");
    try {
      await tickOne(label, Number(chainId), vault as Address, rpc, account);
    } catch (e: any) {
      console.error(`[${label}] tick failed: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
}
