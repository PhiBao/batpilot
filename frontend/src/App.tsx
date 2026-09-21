import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { createPublicClient, decodeEventLog, formatUnits, http, parseUnits } from "viem";
import {
  CHAINS,
  DEFAULT_CHAIN,
  ERC20_ABI,
  REASONS,
  VAULT_ABI,
  fmtPrice,
  fmtTs,
  fmtUSD,
} from "./config";

type PlanRow = {
  id: bigint;
  owner: string;
  stock: string;
  amountPerFill: bigint;
  cadenceSec: bigint;
  stopLossBps: bigint;
  takeProfitBps: bigint;
  usdgBalance: bigint;
  stockBalance: bigint;
  entryAvg: bigint;
  lastFill: bigint;
  yieldShares: bigint;
  active: boolean;
  paused: boolean;
  equity: readonly [bigint, bigint, bigint, bigint];
};

type TrailItem = {
  key: string;
  label: string;
  detail: string;
  tx: string;
  block: bigint;
};

export default function App() {
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN);
  const CH = CHAINS[chainId];
  const USD_D = chainId === 4663 ? 6 : 18;
  const STOCK_NAME: Record<string, string> = Object.fromEntries(
    CH.stocks.map((s) => [s.stock.toLowerCase(), s.symbol])
  );

  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const client = useMemo(
    () => createPublicClient({ chain: CH.chain as any, transport: http(CH.rpc) }),
    [chainId]
  );

  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [trail, setTrail] = useState<TrailItem[]>([]);
  const [status, setStatus] = useState("");
  const [refresh, setRefresh] = useState(0);

  const [stockIdx, setStockIdx] = useState(0);
  const [amount, setAmount] = useState("50");
  const [cadenceMin, setCadenceMin] = useState("1");
  const [sl, setSl] = useState("8");
  const [tp, setTp] = useState("20");
  const [fund, setFund] = useState("1000");

  useEffect(() => setStockIdx(0), [chainId]);

  const refreshAll = useCallback(async () => {
    try {
      const count = (await client.readContract({
        address: CH.vault,
        abi: VAULT_ABI,
        functionName: "planCount",
      })) as bigint;
      const rows: PlanRow[] = [];
      for (let id = 0n; id < count; id++) {
        const p = (await client.readContract({
          address: CH.vault,
          abi: VAULT_ABI,
          functionName: "plans",
          args: [id],
        })) as any;
        const equity = (await client.readContract({
          address: CH.vault,
          abi: VAULT_ABI,
          functionName: "planEquity",
          args: [id],
        })) as readonly [bigint, bigint, bigint, bigint];
        rows.push({
          id, owner: p[0], stock: p[1], amountPerFill: p[3], cadenceSec: p[4],
          stopLossBps: p[5], takeProfitBps: p[6], usdgBalance: p[9],
          stockBalance: p[10], entryAvg: p[11], lastFill: p[12],
          yieldShares: p[14], active: p[15], paused: p[16], equity,
        });
      }
      setPlans(rows);

      let logs: any[] = [];
      try {
        logs = await client.getLogs({ address: CH.vault, fromBlock: 0n, toBlock: "latest" });
      } catch {
        const head = await client.getBlockNumber();
        const from = head > 100_000n ? head - 100_000n : 0n;
        logs = await client.getLogs({ address: CH.vault, fromBlock: from, toBlock: "latest" });
      }
      const items: TrailItem[] = [];
      for (const l of logs) {
        try {
          const d = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
          const a = d.args as any;
          const base = { tx: l.transactionHash!, block: l.blockNumber! };
          if (d.eventName === "Fill")
            items.push({ ...base, key: base.tx + "f", label: `FILL plan #${a.planId}`, detail: `${fmtUSD(a.usdgIn, USD_D)} → ${formatUnits(a.stockOut, 18)} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "GuardRejected")
            items.push({ ...base, key: base.tx + "g", label: `GUARD REFUSED plan #${a.planId}`, detail: `${REASONS[a.reason] ?? a.reason} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "Protected")
            items.push({ ...base, key: base.tx + "p", label: `${a.kind === 1 ? "STOP-LOSS" : "TAKE-PROFIT"} plan #${a.planId}`, detail: `sold ${formatUnits(a.stockSold, 18)} → ${fmtUSD(a.usdgOut, USD_D)} @ ${fmtPrice(a.price)}` });
          else if (d.eventName === "Funded")
            items.push({ ...base, key: base.tx + "fu", label: `FUNDED plan #${a.planId}`, detail: fmtUSD(a.amount, USD_D) });
          else if (d.eventName === "PlanCreated")
            items.push({ ...base, key: base.tx + "c", label: `PLAN #${a.planId} CREATED`, detail: `${fmtUSD(a.amountPerFill, USD_D)} / fill` });
          else if (d.eventName === "Swept")
            items.push({ ...base, key: base.tx + "s", label: `SWEPT plan #${a.planId} → earn`, detail: fmtUSD(a.assets, USD_D) });
          else if (d.eventName === "CorporateActionPause")
            items.push({ ...base, key: base.tx + "ca", label: `CORPORATE ACTION — plan #${a.planId} paused`, detail: `multiplier changed (split/dividend)` });
          else if (d.eventName === "Cancelled")
            items.push({ ...base, key: base.tx + "x", label: `CANCELLED plan #${a.planId}`, detail: `${fmtUSD(a.usdgReturned, USD_D)} returned` });
          else if (d.eventName === "ProtectionSkipped")
            items.push({ ...base, key: base.tx + "ps", label: `PROTECTION SKIPPED plan #${a.planId}`, detail: `stale feed — refused to act blind` });
        } catch { /* ignore undecodable */ }
      }
      items.sort((x, y) => (x.block > y.block ? -1 : 1));
      setTrail(items);
    } catch (e: any) {
      setStatus("read failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }, [client, chainId]);

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 8000);
    return () => clearInterval(t);
  }, [refreshAll, refresh]);

  const txLink = (h: string) => (CH.explorer ? `${CH.explorer}/tx/${h}` : undefined);

  async function needWalletChain(): Promise<boolean> {
    if (!address) return false;
    if (walletChainId !== chainId) {
      setStatus(`switch your wallet to ${CH.name} to transact…`);
      try {
        await switchChain({ chainId: CH.chain.id });
      } catch {
        return false;
      }
    }
    return true;
  }

  async function setupPlan() {
    if (!address || !(await needWalletChain())) return;
    try {
      const s = CH.stocks[stockIdx];
      const amt = parseUnits(amount || "0", USD_D);
      const fundAmt = parseUnits(fund || "0", USD_D);
      setStatus("1/3 approving USDG…");
      await writeContractAsync({
        address: CH.usdg, abi: ERC20_ABI, functionName: "approve",
        args: [CH.vault, fundAmt], chainId: CH.chain.id,
      });
      setStatus("2/3 creating plan…");
      await writeContractAsync({
        address: CH.vault, abi: VAULT_ABI, functionName: "createPlan",
        args: [
          s.stock, s.feed, amt,
          BigInt(Math.max(1, Number(cadenceMin))) * 60n,
          BigInt(Math.round(Number(sl) * 100)),
          BigInt(Math.round(Number(tp) * 100)),
          3600n, 500n,
        ],
        chainId: CH.chain.id,
      });
      const count = (await client.readContract({
        address: CH.vault, abi: VAULT_ABI, functionName: "planCount",
      })) as bigint;
      const id = count - 1n;
      setStatus("3/3 funding plan…");
      await writeContractAsync({
        address: CH.vault, abi: VAULT_ABI, functionName: "fundPlan",
        args: [id, fundAmt], chainId: CH.chain.id,
      });
      setStatus(`plan #${id} live on ${CH.name} — keeper will fill on schedule.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function poke(id: bigint) {
    try {
      setStatus(`checking plan #${id}…`);
      const sim = (await client.simulateContract({
        address: CH.vault, abi: VAULT_ABI, functionName: "executeDCA",
        args: [id], account: address!,
      })) as any;
      if (!(await needWalletChain())) return;
      if (sim.result[0]) {
        await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "executeDCA", args: [id], chainId: CH.chain.id });
        setStatus(`fill executed on plan #${id}.`);
      } else {
        const code = (await client.simulateContract({
          address: CH.vault, abi: VAULT_ABI, functionName: "executeProtection",
          args: [id], account: address!,
        })) as any;
        if (code.result === 1 || code.result === 2) {
          await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "executeProtection", args: [id], chainId: CH.chain.id });
          setStatus(`protection fired on plan #${id}.`);
        } else {
          setStatus(`plan #${id}: nothing due right now (DCA reason ${REASONS[sim.result[1]] ?? sim.result[1]}, protection ${code.result}).`);
        }
      }
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("poke failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function sweep(id: bigint, amt: bigint) {
    try {
      if (!(await needWalletChain())) return;
      await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "sweepToYield", args: [id, amt], chainId: CH.chain.id });
      setStatus(`swept ${fmtUSD(amt, USD_D)} to earn.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("sweep failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function cancel(id: bigint) {
    try {
      if (!(await needWalletChain())) return;
      await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "cancelPlan", args: [id], chainId: CH.chain.id });
      setStatus(`plan #${id} cancelled, funds returned.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("cancel failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function faucet() {
    if (!address || !(await needWalletChain())) return;
    try {
      setStatus("minting test USDG…");
      await writeContractAsync({
        address: CH.usdg, abi: ERC20_ABI, functionName: "mint",
        args: [address!, parseUnits("10000", USD_D)], chainId: CH.chain.id,
      });
      setStatus("10,000 test USDG minted — fund a plan above.");
    } catch {
      setStatus("mint unavailable here (real USDG has no faucet). " + CH.faucetNote);
    }
  }

  const myPlans = useMemo(
    () => plans.filter((p) => !address || p.owner.toLowerCase() === address.toLowerCase()),
    [plans, address]
  );

  return (
    <div className="page">
      <header className="hero">
        <div>
          <div className="brand">BATPILOT</div>
          <h1>Your US stocks, managed while you sleep.</h1>
          <p className="sub">
            Recurring buys + stop-loss / take-profit protection on tokenized stocks.
            Session-aware guard, USDG settlement, verifiable onchain trail.
          </p>
          <div className="row chainrow">
            {Object.values(CHAINS).map((c) => (
              <button
                key={c.id}
                className={c.id === chainId ? "primary" : ""}
                onClick={() => { setChainId(c.id); setStatus(""); }}
              >
                {c.name}
              </button>
            ))}
          </div>
          <p className="dim small">{CH.faucetNote} · vault <code>{CH.vault.slice(0, 10)}…</code></p>
        </div>
        <div className="connect">
          {isConnected ? (
            <>
              <code>{address?.slice(0, 6)}…{address?.slice(-4)}</code>
              <button onClick={() => disconnect()}>disconnect</button>
            </>
          ) : (
            <button className="primary" onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
              connect wallet
            </button>
          )}
        </div>
      </header>

      {status && <div className="status">{status}</div>}

      <section className="card">
        <h2>New autopilot plan <span className="dim">— 60 seconds, set and sleep</span></h2>
        <div className="grid">
          <label>stock
            <select value={stockIdx} onChange={(e) => setStockIdx(Number(e.target.value))}>
              {CH.stocks.map((s, i) => (
                <option key={s.symbol} value={i}>{s.symbol} · ref {s.refPrice}</option>
              ))}
            </select>
          </label>
          <label>buy amount (USDG)<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label>every (min)<input value={cadenceMin} onChange={(e) => setCadenceMin(e.target.value)} /></label>
          <label>stop-loss %<input value={sl} onChange={(e) => setSl(e.target.value)} /></label>
          <label>take-profit %<input value={tp} onChange={(e) => setTp(e.target.value)} /></label>
          <label>fund with (USDG)<input value={fund} onChange={(e) => setFund(e.target.value)} /></label>
        </div>
        <button className="primary" disabled={!isConnected} onClick={setupPlan}>
          {isConnected ? `launch plan on ${CH.name}` : "connect wallet first"}
        </button>{" "}
        {isConnected && chainId !== 4663 && (
          <button title="Mints demo USDG on mock deployments" onClick={faucet}>
            faucet: +10k test USDG
          </button>
        )}
      </section>

      <section>
        <h2>Plans on {CH.name} {myPlans.length > 0 && <span className="dim">({myPlans.length})</span>}</h2>
        {myPlans.length === 0 && <p className="dim">no plans yet — launch one above.</p>}
        {myPlans.map((p) => {
          const total = p.equity[0] + p.equity[2] + p.equity[3];
          return (
            <div className="card plan" key={String(p.id)}>
              <div className="plan-head">
                <strong>#{String(p.id)} {STOCK_NAME[p.stock.toLowerCase()] ?? "STOCK"}</strong>
                <span className={p.active ? (p.paused ? "tag warn" : "tag ok") : "tag"}>
                  {!p.active ? "closed" : p.paused ? "paused (corp. action)" : "active"}
                </span>
              </div>
              <div className="plan-stats">
                <div><span>per fill</span><strong>{fmtUSD(p.amountPerFill, USD_D)}</strong></div>
                <div><span>every</span><strong>{String(p.cadenceSec / 60n)} min</strong></div>
                <div><span>stock held</span><strong>{Number(formatUnits(p.stockBalance, 18)).toFixed(4)}</strong></div>
                <div><span>avg entry</span><strong>{p.entryAvg > 0n ? fmtPrice(p.entryAvg) : "—"}</strong></div>
                <div><span>protection</span><strong>−{Number(p.stopLossBps) / 100}% / +{Number(p.takeProfitBps) / 100}%</strong></div>
                <div><span>total value</span><strong>{fmtUSD(total, USD_D)}</strong></div>
                <div><span>in earn</span><strong>{fmtUSD(p.equity[3], USD_D)}</strong></div>
                <div><span>last fill</span><strong>{p.lastFill > 0n ? fmtTs(p.lastFill) : "—"}</strong></div>
              </div>
              {p.active && (
                <div className="row">
                  <button onClick={() => poke(p.id)}>check &amp; execute now</button>
                  {p.usdgBalance > 0n && (
                    <button onClick={() => sweep(p.id, p.usdgBalance)}>sweep idle → earn</button>
                  )}
                  <button className="danger" onClick={() => cancel(p.id)}>cancel &amp; exit</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section>
        <h2>Verifiable trail <span className="dim">— every fill, refusal, and protection, onchain</span></h2>
        {trail.length === 0 && <p className="dim">no events yet.</p>}
        {trail.map((t) => (
          <div className="trail" key={t.key}>
            <div><strong>{t.label}</strong> <span className="dim">· block {String(t.block)}</span></div>
            <div className="dim">{t.detail}</div>
            {txLink(t.tx) ? (
              <a href={txLink(t.tx)} target="_blank" rel="noreferrer"><code>{t.tx.slice(0, 18)}…</code></a>
            ) : (
              <code>{t.tx.slice(0, 18)}…</code>
            )}
          </div>
        ))}
      </section>

      <footer className="dim">
        batpilot · non-custodial stock autopilot · guard refuses stale fills — never acts blind
      </footer>
    </div>
  );
}
