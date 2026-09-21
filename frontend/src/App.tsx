import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWriteContract,
} from "wagmi";
import { decodeEventLog, formatUnits, parseUnits } from "viem";
import {
  CFG,
  ERC20_ABI,
  REASONS,
  STOCKS,
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

const STOCK_NAME: Record<string, string> = Object.fromEntries(
  STOCKS.map((s) => [s.stock.toLowerCase(), s.symbol])
);

export default function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [trail, setTrail] = useState<TrailItem[]>([]);
  const [status, setStatus] = useState("");
  const [refresh, setRefresh] = useState(0);

  // setup form
  const [stockIdx, setStockIdx] = useState(0);
  const [amount, setAmount] = useState("50");
  const [cadenceMin, setCadenceMin] = useState("1");
  const [sl, setSl] = useState("8");
  const [tp, setTp] = useState("20");
  const [fund, setFund] = useState("1000");

  const refreshAll = useCallback(async () => {
    if (!publicClient) return;
    try {
      const count = (await publicClient.readContract({
        address: CFG.vault,
        abi: VAULT_ABI,
        functionName: "planCount",
      })) as bigint;
      const rows: PlanRow[] = [];
      for (let id = 0n; id < count; id++) {
        const p = (await publicClient.readContract({
          address: CFG.vault,
          abi: VAULT_ABI,
          functionName: "plans",
          args: [id],
        })) as any;
        const equity = (await publicClient.readContract({
          address: CFG.vault,
          abi: VAULT_ABI,
          functionName: "planEquity",
          args: [id],
        })) as readonly [bigint, bigint, bigint, bigint];
        rows.push({
          id,
          owner: p[0],
          stock: p[1],
          amountPerFill: p[3],
          cadenceSec: p[4],
          stopLossBps: p[5],
          takeProfitBps: p[6],
          usdgBalance: p[9],
          stockBalance: p[10],
          entryAvg: p[11],
          lastFill: p[12],
          yieldShares: p[14],
          active: p[15],
          paused: p[16],
          equity,
        });
      }
      setPlans(rows);

      const logs = await publicClient.getLogs({
        address: CFG.vault,
        fromBlock: 0n,
        toBlock: "latest",
      });
      const items: TrailItem[] = [];
      for (const l of logs) {
        try {
          const d = decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics });
          const a = d.args as any;
          const base = { tx: l.transactionHash!, block: l.blockNumber! };
          if (d.eventName === "Fill")
            items.push({ ...base, key: base.tx + "f", label: `FILL plan #${a.planId}`, detail: `${fmtUSD(a.usdgIn)} → ${formatUnits(a.stockOut, 18)} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "GuardRejected")
            items.push({ ...base, key: base.tx + "g", label: `GUARD REFUSED plan #${a.planId}`, detail: `${REASONS[a.reason] ?? a.reason} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "Protected")
            items.push({ ...base, key: base.tx + "p", label: `${a.kind === 1 ? "STOP-LOSS" : "TAKE-PROFIT"} plan #${a.planId}`, detail: `sold ${formatUnits(a.stockSold, 18)} → ${fmtUSD(a.usdgOut)} @ ${fmtPrice(a.price)}` });
          else if (d.eventName === "Funded")
            items.push({ ...base, key: base.tx + "fu", label: `FUNDED plan #${a.planId}`, detail: fmtUSD(a.amount) });
          else if (d.eventName === "PlanCreated")
            items.push({ ...base, key: base.tx + "c", label: `PLAN #${a.planId} CREATED`, detail: `${fmtUSD(a.amountPerFill)} / fill` });
          else if (d.eventName === "Swept")
            items.push({ ...base, key: base.tx + "s", label: `SWEPT plan #${a.planId} → earn`, detail: fmtUSD(a.assets) });
          else if (d.eventName === "CorporateActionPause")
            items.push({ ...base, key: base.tx + "ca", label: `CORPORATE ACTION — plan #${a.planId} paused`, detail: `multiplier changed (split/dividend)` });
          else if (d.eventName === "Cancelled")
            items.push({ ...base, key: base.tx + "x", label: `CANCELLED plan #${a.planId}`, detail: `${fmtUSD(a.usdgReturned)} returned` });
          else if (d.eventName === "ProtectionSkipped")
            items.push({ ...base, key: base.tx + "ps", label: `PROTECTION SKIPPED plan #${a.planId}`, detail: `stale feed — refused to act blind` });
        } catch {
          /* ignore undecodable */
        }
      }
      items.sort((x, y) => (x.block > y.block ? -1 : 1));
      setTrail(items);
    } catch (e: any) {
      setStatus("read failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }, [publicClient]);

  useEffect(() => {
    refreshAll();
    const t = setInterval(refreshAll, 8000);
    return () => clearInterval(t);
  }, [refreshAll, refresh]);

  const txLink = (h: string) =>
    CFG.explorer ? `${CFG.explorer}/tx/${h}` : undefined;

  async function setupPlan() {
    if (!address) return;
    try {
      const s = STOCKS[stockIdx];
      const amt = parseUnits(amount || "0", 18);
      const fundAmt = parseUnits(fund || "0", 18);
      setStatus("1/3 approving USDG…");
      await writeContractAsync({
        address: CFG.usdg,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [CFG.vault, fundAmt],
      });
      setStatus("2/3 creating plan…");
      await writeContractAsync({
        address: CFG.vault,
        abi: VAULT_ABI,
        functionName: "createPlan",
        args: [
          s.stock, s.feed, amt,
          BigInt(Math.max(1, Number(cadenceMin))) * 60n,
          BigInt(Math.round(Number(sl) * 100)),
          BigInt(Math.round(Number(tp) * 100)),
          3600n, 500n,
        ],
      });
      const count = (await publicClient!.readContract({
        address: CFG.vault, abi: VAULT_ABI, functionName: "planCount",
      })) as bigint;
      const id = count - 1n;
      setStatus("3/3 funding plan…");
      await writeContractAsync({
        address: CFG.vault, abi: VAULT_ABI, functionName: "fundPlan", args: [id, fundAmt],
      });
      setStatus(`plan #${id} live — keeper will fill on schedule.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function poke(id: bigint) {
    try {
      setStatus(`checking plan #${id}…`);
      const sim = (await publicClient!.simulateContract({
        address: CFG.vault, abi: VAULT_ABI, functionName: "executeDCA",
        args: [id], account: address!,
      })) as any;
      if (sim.result[0]) {
        await writeContractAsync({ address: CFG.vault, abi: VAULT_ABI, functionName: "executeDCA", args: [id] });
        setStatus(`fill executed on plan #${id}.`);
      } else {
        const code = (await publicClient!.simulateContract({
          address: CFG.vault, abi: VAULT_ABI, functionName: "executeProtection",
          args: [id], account: address!,
        })) as any;
        if (code.result === 1 || code.result === 2) {
          await writeContractAsync({ address: CFG.vault, abi: VAULT_ABI, functionName: "executeProtection", args: [id] });
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
      await writeContractAsync({ address: CFG.vault, abi: VAULT_ABI, functionName: "sweepToYield", args: [id, amt] });
      setStatus(`swept ${fmtUSD(amt)} to earn.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("sweep failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function cancel(id: bigint) {
    try {
      await writeContractAsync({ address: CFG.vault, abi: VAULT_ABI, functionName: "cancelPlan", args: [id] });
      setStatus(`plan #${id} cancelled, funds returned.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("cancel failed: " + (e?.shortMessage ?? e?.message ?? e));
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
              {STOCKS.map((s, i) => (
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
          {isConnected ? "launch plan" : "connect wallet first"}
        </button>
      </section>

      <section>
        <h2>Plans {myPlans.length > 0 && <span className="dim">({myPlans.length})</span>}</h2>
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
                <div><span>per fill</span><strong>{fmtUSD(p.amountPerFill)}</strong></div>
                <div><span>every</span><strong>{String(p.cadenceSec / 60n)} min</strong></div>
                <div><span>stock held</span><strong>{Number(formatUnits(p.stockBalance, 18)).toFixed(4)}</strong></div>
                <div><span>avg entry</span><strong>{p.entryAvg > 0n ? fmtPrice(p.entryAvg) : "—"}</strong></div>
                <div><span>protection</span><strong>−{Number(p.stopLossBps) / 100}% / +{Number(p.takeProfitBps) / 100}%</strong></div>
                <div><span>total value</span><strong>{fmtUSD(total)}</strong></div>
                <div><span>in earn</span><strong>{fmtUSD(p.equity[3])}</strong></div>
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
