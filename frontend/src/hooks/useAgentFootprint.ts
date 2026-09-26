import { useEffect, useState } from "react";
import { createPublicClient, decodeEventLog, http } from "viem";
import { CHAINS, VAULT_ABI, fmtTs } from "../config";

export const AGENT_WALLET = "0x4f7163e63C7fd492dEd6846DC38Fef0D8b4dE9b3";
export const AGENT_ID = "4524";
export const SERV_AGENT_DIR =
  "https://github.com/PhiBao/batpilot/tree/main/serv-agent";
export const OPENSERV_CONSOLE = "https://console.openserv.ai/";

export const WHY: Record<number, string> = {
  1: "the price feed was stale, so it refused to trade blind",
  2: "the plan was paused after a corporate action like a split",
  3: "the price moved too far too fast versus its band",
  5: "it was cooling down after a protection sale, sitting out the aftershock",
};

export type AgentPlan = { id: bigint; sym: string; active: boolean; total: bigint };
export type Refusal = {
  chain: string;
  planId: string;
  reason: number;
  price: bigint;
  feedTs: bigint;
  tx: string;
  explorer: string;
  block: bigint;
};

/** Live onchain footprint of the Batpilot SERV agent: plans it owns on mainnet + latest guard decision anywhere. */
export function useAgentFootprint(refreshKey: unknown = 0) {
  const [agentPlans, setAgentPlans] = useState<AgentPlan[]>([]);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const mc = CHAINS[4663];
        const tc = CHAINS[46630];
        const mpub = createPublicClient({ chain: mc.chain as any, transport: http(mc.rpc) });
        const count = (await mpub.readContract({
          address: mc.vault,
          abi: VAULT_ABI,
          functionName: "planCount",
        })) as bigint;
        const rows: AgentPlan[] = [];
        const names: Record<string, string> = Object.fromEntries(
          mc.stocks.map((s) => [s.stock.toLowerCase(), s.symbol])
        );
        for (let id = 0n; id < count; id++) {
          const p = (await mpub.readContract({
            address: mc.vault,
            abi: VAULT_ABI,
            functionName: "plans",
            args: [id],
          })) as any;
          if ((p[0] as string).toLowerCase() !== AGENT_WALLET.toLowerCase()) continue;
          const eq = (await mpub.readContract({
            address: mc.vault,
            abi: VAULT_ABI,
            functionName: "planEquity",
            args: [id],
          })) as readonly [bigint, bigint, bigint, bigint];
          rows.push({
            id,
            sym: names[(p[1] as string).toLowerCase()] ?? "STOCK",
            active: p[16] as boolean,
            total: eq[0] + eq[2] + eq[3],
          });
        }
        // Latest refusal across both chains (testnet rehearsals share the bytecode).
        let best: Refusal | null = null;
        for (const c of [mc, tc]) {
          try {
            const pub =
              c === mc
                ? mpub
                : createPublicClient({ chain: tc.chain as any, transport: http(tc.rpc) });
            // Our vaults are young — every event on them is ours. Full range,
            // so rehearsed refusals never age out of the window.
            const logs = await pub.getLogs({
              address: c.vault,
              fromBlock: 0n,
              toBlock: "latest",
            });
            for (const l of logs) {
              try {
                const d = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
                if (d.eventName !== "GuardRejected" && d.eventName !== "ProtectionSkipped")
                  continue;
                const a = d.args as any;
                const code = Number(a.reason ?? 0);
                if (!best || l.blockNumber! > best.block) {
                  best = {
                    chain: c.name,
                    planId: String(a.planId ?? ""),
                    reason: code,
                    price: (a.price ?? 0n) as bigint,
                    feedTs: (a.feedTs ?? 0n) as bigint,
                    tx: l.transactionHash!,
                    explorer: c.explorer,
                    block: l.blockNumber!,
                  };
                }
              } catch {
                /* skip undecodable */
              }
            }
          } catch {
            /* chain unreadable */
          }
        }
        if (!stop) {
          setAgentPlans(rows);
          setRefusal(best);
        }
      } catch {
        /* silent: page shows empty states */
      }
    })();
    return () => {
      stop = true;
    };
  }, [refreshKey]);

  return { agentPlans, refusal };
}

export { fmtTs };
