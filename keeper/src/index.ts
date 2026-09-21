import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import "dotenv/config";

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

async function main() {
  const rpc = process.env.RPC_URL;
  const pk = process.env.PRIVATE_KEY as Address | undefined;
  const vault = process.env.VAULT as Address | undefined;
  const chainId = Number(process.env.CHAIN_ID ?? 421614); // Arbitrum Sepolia default
  const intervalMs = Number(process.env.INTERVAL_MS ?? 30_000);

  if (!rpc || !pk || !vault) {
    throw new Error("Missing RPC_URL / PRIVATE_KEY / VAULT env");
  }

  const chain: Chain = {
    id: chainId,
    name: "batpilot",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc) });

  console.log(`[batpilot-keeper] vault=${vault} keeper=${account.address} tick=${intervalMs}ms`);

  for (;;) {
    let active = 0n;
    try {
      const count = await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "planCount",
      });
      for (let id = 0n; id < count; id++) {
        const p = await publicClient.readContract({
          address: vault,
          abi: VAULT_ABI,
          functionName: "plans",
          args: [id],
        });
        if (!p[15]) continue; // plans(id).active
        active++;

        // 1) Scheduled buy — simulate first (contract decides), send only on action.
        try {
          const [executed, reason] = await publicClient.simulateContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: "executeDCA",
            args: [id],
            account: account.address,
          }).then((r) => r.result as unknown as [boolean, number]);
          if (executed) {
            const hash = await wallet.writeContract({
              address: vault,
              abi: VAULT_ABI,
              functionName: "executeDCA",
              args: [id],
            });
            console.log(`[plan ${id}] DCA fill sent: ${hash}`);
          } else if (reason !== 0) {
            console.log(`[plan ${id}] DCA skipped: ${REASONS[reason] ?? reason}`);
          }
        } catch (e: any) {
          console.log(`[plan ${id}] DCA simulate reverted (not due/funded): ${shortErr(e)}`);
        }

        // 2) Protection — same pattern.
        try {
          const [code] = await publicClient.simulateContract({
            address: vault,
            abi: VAULT_ABI,
            functionName: "executeProtection",
            args: [id],
            account: account.address,
          }).then((r) => [r.result as unknown as number]);
          if (code === 1 || code === 2) {
            const hash = await wallet.writeContract({
              address: vault,
              abi: VAULT_ABI,
              functionName: "executeProtection",
              args: [id],
            });
            console.log(`[plan ${id}] PROTECTION fired (${code === 1 ? "STOP" : "TAKE"}): ${hash}`);
          } else if (code === 3) {
            console.log(`[plan ${id}] protection skipped (stale — never acts blind)`);
          }
        } catch (e: any) {
          console.log(`[plan ${id}] protection simulate reverted: ${shortErr(e)}`);
        }
      }
    } catch (e: any) {
      console.error(`[keeper] tick failed: ${shortErr(e)}`);
    }
    console.log(`[keeper] tick done: ${new Date().toISOString()} activePlans=${active}`);
    await sleep(intervalMs);
  }
}

function shortErr(e: any): string {
  const m = String(e?.shortMessage ?? e?.message ?? e);
  return m.slice(0, 160);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
