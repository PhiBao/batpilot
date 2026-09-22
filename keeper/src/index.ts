import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
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

type Target = {
  label: string;
  chain: Chain;
  vault: Address;
  public: PublicClient;
  wallet: WalletClient;
};

function chainDef(chainId: number, rpc: string): Chain {
  return {
    id: chainId,
    name: `batpilot-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  };
}

async function tickTarget(t: Target, account: Address) {
  const count = await t.public.readContract({
    address: t.vault,
    abi: VAULT_ABI,
    functionName: "planCount",
  });
  let active = 0n;
  for (let id = 0n; id < count; id++) {
    const p = await t.public.readContract({
      address: t.vault,
      abi: VAULT_ABI,
      functionName: "plans",
      args: [id],
    });
    if (!p[15]) continue; // plans(id).active
    active++;

    try {
      const [executed, reason] = await t.public
        .simulateContract({
          address: t.vault,
          abi: VAULT_ABI,
          functionName: "executeDCA",
          args: [id],
          account,
        })
        .then((r) => r.result as unknown as [boolean, number]);
      if (executed) {
        const hash = await t.wallet.writeContract({
          address: t.vault,
          abi: VAULT_ABI,
          functionName: "executeDCA",
          args: [id],
          account,
          chain: t.chain,
        });
        console.log(`[${t.label} plan ${id}] DCA fill sent: ${hash}`);
      } else if (reason !== 0) {
        console.log(`[${t.label} plan ${id}] DCA skipped: ${REASONS[reason] ?? reason}`);
      }
    } catch (e: any) {
      console.log(`[${t.label} plan ${id}] DCA simulate reverted (not due/funded): ${shortErr(e)}`);
    }

    try {
      const [code] = await t.public
        .simulateContract({
          address: t.vault,
          abi: VAULT_ABI,
          functionName: "executeProtection",
          args: [id],
          account,
        })
        .then((r) => [r.result as unknown as number]);
      if (code === 1 || code === 2) {
        const hash = await t.wallet.writeContract({
          address: t.vault,
          abi: VAULT_ABI,
          functionName: "executeProtection",
          args: [id],
          account,
          chain: t.chain,
        });
        console.log(`[${t.label} plan ${id}] PROTECTION fired (${code === 1 ? "STOP" : "TAKE"}): ${hash}`);
      } else if (code === 3) {
        console.log(`[${t.label} plan ${id}] protection skipped (stale — never acts blind)`);
      }
    } catch (e: any) {
      console.log(`[${t.label} plan ${id}] protection simulate reverted: ${shortErr(e)}`);
    }
  }
  return active;
}

async function main() {
  const pk = process.env.PRIVATE_KEY as Address | undefined;
  const intervalMs = Number(process.env.INTERVAL_MS ?? 30_000);

  // WATCH="label:chainId:vault:rpc,label:chainId:vault:rpc,..."
  // Falls back to single-target VAULT / RPC_URL / CHAIN_ID env.
  const raw =
    process.env.WATCH ??
    (process.env.VAULT
      ? `single:${process.env.CHAIN_ID ?? 421614}:${process.env.VAULT}:${process.env.RPC_URL ?? ""}`
      : "");

  const account = pk ? privateKeyToAccount(pk) : null;

  const targets: Target[] = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, chainId, vault, ...rpcParts] = entry.split(":");
      const rpc = rpcParts.join(":");
      if (!account || !label || !chainId || !vault || !rpc) {
        throw new Error(`bad WATCH entry or missing key: ${entry}`);
      }
      const chain = chainDef(Number(chainId), rpc);
      const transport = http(rpc);
      return {
        label,
        chain,
        vault: vault as Address,
        public: createPublicClient({ chain, transport }) as PublicClient,
        wallet: createWalletClient({ account, chain, transport }) as WalletClient,
      };
    });

  if (targets.length === 0) {
    throw new Error("Missing WATCH (label:chainId:vault:rpc,...) or VAULT/RPC_URL/CHAIN_ID env");
  }

  if (targets.length === 0) {
    throw new Error("Missing WATCH (label:chainId:vault:rpc,...) or VAULT/RPC_URL/CHAIN_ID env");
  }

  const keeper = targets[0].wallet.account!.address;
  console.log(
    `[batpilot-keeper] keeper=${keeper} tick=${intervalMs}ms targets=${targets.map((t) => t.label).join(",")}`
  );

  for (;;) {
    for (const t of targets) {
      try {
        const active = await tickTarget(t, keeper);
        console.log(`[keeper] ${t.label}: tick done, activePlans=${active}`);
      } catch (e: any) {
        console.error(`[keeper] ${t.label} tick failed: ${shortErr(e)}`);
      }
    }
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
