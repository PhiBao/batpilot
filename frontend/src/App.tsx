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
  FEED_ABI,
  REASONS,
  VAULT_ABI,
  fmtPrice,
  fmtTs,
  fmtUSD,
} from "./config";

type FillMark = { price: bigint; ts: bigint };

type HistPoint = { price: bigint; ts: bigint };

function Sparkline({ data, marks, w = 280, h = 64 }: { data: HistPoint[]; marks: FillMark[]; w?: number; h?: number }) {
  if (data.length < 2) return <div className="dim small">not enough history yet</div>;
  const prices = data.map((d) => Number(d.price));
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;
  const X = (i: number) => (i / (data.length - 1)) * (w - 8) + 4;
  const Y = (p: number) => h - 6 - ((p - lo) / span) * (h - 12);
  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(Number(d.price)).toFixed(1)}`).join(" ");
  // Mark fills whose price falls inside the visible window.
  const dots = marks
    .map((m) => {
      let best = -1;
      let bestDt = Infinity;
      data.forEach((d, i) => {
        const dt = Math.abs(Number(d.ts) - Number(m.ts));
        if (dt < bestDt) { bestDt = dt; best = i; }
      });
      if (best < 0 || bestDt > 7 * 24 * 3600) return null;
      return { x: X(best), y: Y(Number(m.price)) };
    })
    .filter(Boolean) as { x: number; y: number }[];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label="price history">
      <path d={`${line} L${(w - 4).toFixed(1)},${h} L4,${h} Z`} fill="var(--acid-soft)" opacity="0.7" />
      <path d={line} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="4" fill="var(--acid)" stroke="var(--ink)" strokeWidth="1.5" />
      ))}
      <text x={w - 4} y={14} textAnchor="end" fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">
        ${((hi as number) / 1e8).toFixed(2)}
      </text>
      <text x={w - 4} y={h - 4} textAnchor="end" fontSize="11" fill="var(--muted)" fontFamily="var(--mono)">
        ${((lo as number) / 1e8).toFixed(2)}
      </text>
    </svg>
  );
}

type PlanRow = {
  id: bigint;
  owner: string;
  stock: string;
  feed: string;
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
  kind: "fill" | "stop" | "refuse" | "info";
  label: string;
  detail: string;
  tx: string;
  block: bigint;
  planId: string;
  fillPrice?: bigint;
  fillTs?: bigint;
};

function positionPnl(p: PlanRow, stockValue: bigint, usdD: number) {
  if (p.stockBalance === 0n || p.entryAvg === 0n) return null;
  const costRaw = (p.stockBalance * p.entryAvg) / BigInt(1e8); // 18-dec scale
  const cost = usdD === 6 ? costRaw / BigInt(1e12) : costRaw;
  if (cost === 0n) return null;
  const pnl = stockValue - cost;
  const pct = (pnl * 10000n) / cost; // bps
  return { pnl, pct };
}

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
  const [hist, setHist] = useState<Record<string, HistPoint[]>>({});
  const [status, setStatus] = useState("");
  const [refresh, setRefresh] = useState(0);

  const [stockIdx, setStockIdx] = useState(0);
  const [amount, setAmount] = useState("50");
  const [cadenceMin, setCadenceMin] = useState("15");
  const [sl, setSl] = useState("8");
  const [tp, setTp] = useState("20");
  const [slip, setSlip] = useState("2");
  const [fund, setFund] = useState("1000");
  const [newPrice, setNewPrice] = useState("");
  const [page, setPage] = useState(0);
  const PAGE = 8;

  useEffect(() => setStockIdx(0), [chainId]);
  useEffect(() => setPage(0), [chainId]);

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
          id, owner: p[0], stock: p[1], feed: p[2], amountPerFill: p[3], cadenceSec: p[4],
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
          const base = { tx: l.transactionHash!, block: l.blockNumber!, planId: String(a.planId ?? "") };
          if (d.eventName === "Fill")
            items.push({ ...base, key: base.tx + "f", kind: "fill", fillPrice: a.price as bigint, fillTs: a.feedTs as bigint, label: `Fill — plan #${a.planId}`, detail: `${fmtUSD(a.usdgIn, USD_D)} → ${formatUnits(a.stockOut, 18)} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "GuardRejected")
            items.push({ ...base, key: base.tx + "g", kind: "refuse", label: `Guard refused — plan #${a.planId}`, detail: `${REASONS[a.reason] ?? a.reason} @ ${fmtPrice(a.price)} · feed ${fmtTs(a.feedTs)}` });
          else if (d.eventName === "Protected")
            items.push({ ...base, key: base.tx + "p", kind: "stop", label: `${a.kind === 1 ? "Stop-loss" : "Take-profit"} — plan #${a.planId}`, detail: `sold ${formatUnits(a.stockSold, 18)} → ${fmtUSD(a.usdgOut, USD_D)} @ ${fmtPrice(a.price)}` });
          else if (d.eventName === "Funded")
            items.push({ ...base, key: base.tx + "fu", kind: "info", label: `Funded — plan #${a.planId}`, detail: fmtUSD(a.amount, USD_D) });
          else if (d.eventName === "PlanCreated")
            items.push({ ...base, key: base.tx + "c", kind: "info", label: `Plan #${a.planId} created`, detail: `${fmtUSD(a.amountPerFill, USD_D)} / fill` });
          else if (d.eventName === "Swept")
            items.push({ ...base, key: base.tx + "s", kind: "fill", label: `Swept to earn — plan #${a.planId}`, detail: fmtUSD(a.assets, USD_D) });
          else if (d.eventName === "CorporateActionPause")
            items.push({ ...base, key: base.tx + "ca", kind: "refuse", label: `Corporate action — plan #${a.planId} paused`, detail: `multiplier changed (split/dividend)` });
          else if (d.eventName === "Cancelled")
            items.push({ ...base, key: base.tx + "x", kind: "info", label: `Cancelled — plan #${a.planId}`, detail: `${fmtUSD(a.usdgReturned, USD_D)} returned` });
          else if (d.eventName === "ProtectionSkipped")
            items.push({ ...base, key: base.tx + "ps", kind: "refuse", label: `Protection skipped — plan #${a.planId}`, detail: `stale feed — refused to act blind` });
        } catch { /* ignore undecodable */ }
      }
      items.sort((x, y) => (x.block > y.block ? -1 : 1));
      setTrail(items);

      // Feed history per unique stock feed (cap 24 rounds back) for sparklines.
      const feeds = [...new Set(rows.map((r) => r.feed))];
      const h: Record<string, HistPoint[]> = {};
      await Promise.all(
        feeds.map(async (f) => {
          try {
            const latest = (await client.readContract({
              address: f as `0x${string}`, abi: FEED_ABI, functionName: "latestRoundData",
            })) as any;
            const latestId = BigInt(latest[0]);
            const pts: HistPoint[] = [];
            const start = latestId > 24n ? latestId - 24n : 1n;
            for (let r = start; r <= latestId; r++) {
              try {
                const rd = (await client.readContract({
                  address: f as `0x${string}`, abi: FEED_ABI, functionName: "getRoundData", args: [r],
                })) as any;
                if (rd[1] > 0n) pts.push({ price: rd[1] as bigint, ts: rd[3] as bigint });
              } catch { /* skip unreadable rounds */ }
            }
            h[f.toLowerCase()] = pts;
          } catch { /* feed without history */ }
        })
      );
      setHist(h);
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
      setStatus("1/3 — approving USDG…");
      await writeContractAsync({
        address: CH.usdg, abi: ERC20_ABI, functionName: "approve",
        args: [CH.vault, fundAmt], chainId: CH.chain.id,
      });
      setStatus("2/3 — creating plan…");
      await writeContractAsync({
        address: CH.vault, abi: VAULT_ABI, functionName: "createPlan",
        args: [
          s.stock, s.feed, amt,
          BigInt(Math.max(1, Number(cadenceMin))) * 60n,
          BigInt(Math.round(Number(sl) * 100)),
          BigInt(Math.round(Number(tp) * 100)),
          3600n, 500n,
          BigInt(Math.round(Number(slip) * 100)),
        ],
        chainId: CH.chain.id,
      });
      const count = (await client.readContract({
        address: CH.vault, abi: VAULT_ABI, functionName: "planCount",
      })) as bigint;
      const id = count - 1n;
      setStatus("3/3 — funding plan…");
      await writeContractAsync({
        address: CH.vault, abi: VAULT_ABI, functionName: "fundPlan",
        args: [id, fundAmt], chainId: CH.chain.id,
      });
      setStatus(`Plan #${id} live on ${CH.name} — the keeper fills on schedule.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function poke(id: bigint) {
    try {
      setStatus(`Checking plan #${id}…`);
      const sim = (await client.simulateContract({
        address: CH.vault, abi: VAULT_ABI, functionName: "executeDCA",
        args: [id], account: address!,
      })) as any;
      if (!(await needWalletChain())) return;
      if (sim.result[0]) {
        await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "executeDCA", args: [id], chainId: CH.chain.id });
        setStatus(`Fill executed on plan #${id}.`);
      } else {
        const code = (await client.simulateContract({
          address: CH.vault, abi: VAULT_ABI, functionName: "executeProtection",
          args: [id], account: address!,
        })) as any;
        if (code.result === 1 || code.result === 2) {
          await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "executeProtection", args: [id], chainId: CH.chain.id });
          setStatus(`Protection fired on plan #${id}.`);
        } else {
          setStatus(`Plan #${id}: nothing due (DCA: ${REASONS[sim.result[1]] ?? sim.result[1]}, protection: ${code.result}).`);
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
      setStatus(`Swept ${fmtUSD(amt, USD_D)} to earn.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("sweep failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function topUp(id: bigint, perFill: bigint) {
    try {
      if (!(await needWalletChain())) return;
      const amt = perFill * 10n; // ≈10 more fills
      const allow = (await client.readContract({
        address: CH.usdg, abi: ERC20_ABI, functionName: "balanceOf", args: [address!],
      })) as bigint;
      if (allow < amt) {
        setStatus(`You hold ${fmtUSD(allow, USD_D)} — less than ${fmtUSD(amt, USD_D)}. Mint or buy USDG first.`);
        return;
      }
      setStatus("Approving + topping up…");
      await writeContractAsync({
        address: CH.usdg, abi: ERC20_ABI, functionName: "approve",
        args: [CH.vault, amt], chainId: CH.chain.id,
      });
      await writeContractAsync({
        address: CH.vault, abi: VAULT_ABI, functionName: "fundPlan",
        args: [id, amt], chainId: CH.chain.id,
      });
      setStatus(`Topped up ${fmtUSD(amt, USD_D)} — the trail never goes quiet.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("top-up failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  async function cancel(id: bigint) {
    try {
      if (!(await needWalletChain())) return;
      await writeContractAsync({ address: CH.vault, abi: VAULT_ABI, functionName: "cancelPlan", args: [id], chainId: CH.chain.id });
      setStatus(`Plan #${id} cancelled, funds returned.`);
      setRefresh((r) => r + 1);
    } catch (e: any) {
      setStatus("cancel failed: " + (e?.shortMessage ?? e?.message ?? e));
    }
  }

  // Demo market control (mock feeds only — real Chainlink feeds reject this).
  async function setFeedPrice() {
    if (!address || !(await needWalletChain())) return;
    const v = Number(newPrice);
    if (!v || v <= 0) {
      setStatus("enter a price like 162 to simulate a crash.");
      return;
    }
    try {
      setStatus(`setting demo ${CH.stocks[stockIdx].symbol} price to $${v}…`);
      await writeContractAsync({
        address: CH.stocks[stockIdx].feed, abi: FEED_ABI, functionName: "setPrice",
        args: [BigInt(Math.round(v * 1e8))], chainId: CH.chain.id,
      });
      setStatus(`demo price set to $${v} — watch the guard and protection react.`);
      setRefresh((r) => r + 1);
    } catch {
      setStatus("price control unavailable here — this feed is a real Chainlink feed.");
    }
  }

  async function faucet() {    if (!address || !(await needWalletChain())) return;
    try {
      setStatus("Minting test USDG…");
      await writeContractAsync({
        address: CH.usdg, abi: ERC20_ABI, functionName: "mint",
        args: [address!, parseUnits("10000", USD_D)], chainId: CH.chain.id,
      });
      setStatus("10,000 test USDG minted — fund a plan below.");
    } catch {
      setStatus("Mint unavailable here (real USDG has no faucet). " + CH.faucetNote);
    }
  }

  const myPlans = useMemo(
    () => plans.filter((p) => !address || p.owner.toLowerCase() === address.toLowerCase()),
    [plans, address]
  );

  const fillsFor = useCallback(
    (id: bigint): FillMark[] =>
      trail
        .filter((t) => t.kind === "fill" && t.planId === String(id) && t.fillPrice && t.fillTs)
        .map((t) => ({ price: t.fillPrice!, ts: t.fillTs! })),
    [trail]
  );

  const portfolio = useMemo(() => {    let value = 0n;
    let pnl = 0n;
    for (const p of myPlans) {
      value += p.equity[0] + p.equity[2] + p.equity[3];
      const d = positionPnl(p, p.equity[2], USD_D);
      if (d) pnl += d.pnl;
    }
    return { value, pnl };
  }, [myPlans, USD_D]);

  const pageCount = Math.max(1, Math.ceil(trail.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);

  return (
    <div className="page">
      <div className="topbar">
        <div className="brand">BATPILOT<em>RHC</em></div>
        <div className="connect">
          {isConnected ? (
            <>
              <code>{address?.slice(0, 6)}…{address?.slice(-4)}</code>
              <button className="btn" onClick={() => disconnect()}>Disconnect</button>
            </>
          ) : (
            <button className="btn primary" onClick={() => connectors[0] && connect({ connector: connectors[0] })}>
              Connect wallet
            </button>
          )}
        </div>
      </div>

      <header className="hero">
        <h1>US stocks, <span className="accent">managed</span> while you sleep.</h1>
        <p className="lede">
          Recurring buys and stop-loss protection on tokenized stocks —
          enforced by a volatility-aware onchain guard, settled in USDG,
          verifiable block by block.
        </p>
        <div className="tabs">
          {Object.values(CHAINS).map((c) => (
            <button
              key={c.id}
              className={c.id === chainId ? "on" : ""}
              onClick={() => { setChainId(c.id); setStatus(""); }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <p className="chainnote">{CH.faucetNote} · vault <code>{CH.vault.slice(0, 10)}…</code></p>
      </header>

      {status && <div className="status">{status}</div>}

      <section>
        <div className="sec-head">
          <span className="sec-num">01</span>
          <h2>New autopilot plan</h2>
          <span className="dim">60 seconds, set and sleep</span>
        </div>
        <div className="panel">
          <div className="fields">
            <label>Stock
              <select value={stockIdx} onChange={(e) => setStockIdx(Number(e.target.value))}>
                {CH.stocks.map((s, i) => (
                  <option key={s.symbol} value={i}>{s.symbol} · {s.refPrice}</option>
                ))}
              </select>
            </label>
            <label>Buy amount · USDG<input value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label>Every · min<input value={cadenceMin} onChange={(e) => setCadenceMin(e.target.value)} /></label>
          <label>Stop-loss · %<input value={sl} onChange={(e) => setSl(e.target.value)} /></label>
          <label>Take-profit · %<input value={tp} onChange={(e) => setTp(e.target.value)} /></label>
          <label>Slippage · %<input value={slip} onChange={(e) => setSlip(e.target.value)} /></label>
          <label>Fund with · USDG<input value={fund} onChange={(e) => setFund(e.target.value)} /></label>
          </div>
          <div className="btnrow">
            <button className="btn primary" disabled={!isConnected} onClick={setupPlan}>
              {isConnected ? `Launch plan on ${CH.name}` : "Connect wallet first"}
            </button>
            {isConnected && chainId !== 4663 && (
              <button className="btn" onClick={faucet}>Faucet · +10k test USDG</button>
            )}
          </div>
          {isConnected && chainId !== 4663 && (
            <div className="marketctl">
              <span>Demo market — move the mock feed to rehearse protection:</span>
              <input
                value={newPrice}
                onChange={(e) => setNewPrice(e.target.value)}
                placeholder={`e.g. ${(Number(CH.stocks[stockIdx].refPrice.replace(/[^0-9.]/g, "")) * 0.9).toFixed(0)} for a crash`}
              />
              <button className="btn" onClick={setFeedPrice}>Set {CH.stocks[stockIdx].symbol} price</button>
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="sec-num">02</span>
          <h2>Plans</h2>
          <span className="dim">{CH.name}{myPlans.length > 0 && ` · ${myPlans.length}`}</span>
        </div>
        {myPlans.length > 0 && (
          <p className="portfolioline">
            Portfolio <strong>{fmtUSD(portfolio.value, USD_D)}</strong>
            {" · "}
            <strong className={portfolio.pnl >= 0n ? "pos" : "neg"}>
              {portfolio.pnl >= 0n ? "+" : "−"}{fmtUSD(portfolio.pnl >= 0n ? portfolio.pnl : -portfolio.pnl, USD_D)} unrealized
            </strong>
          </p>
        )}
        {myPlans.length === 0 && <p className="empty">No plans yet — launch one above.</p>}
        {myPlans.map((p) => {
          const total = p.equity[0] + p.equity[2] + p.equity[3];
          const fillsLeft = p.amountPerFill > 0n ? p.usdgBalance / p.amountPerFill : 0n;
          const lowFunds = p.active && fillsLeft < 3n;
          const delta = positionPnl(p, p.equity[2], USD_D);
          const rawHist = hist[p.feed?.toLowerCase?.() ?? ""] ?? [];
          const marks = fillsFor(p.id);
          // Fallback when the feed exposes no round history (e.g. mock feeds):
          // plot the plan's own execution history + live position instead.
          const data = (() => {
            if (rawHist.length >= 2) return rawHist;
            const pts = [...marks]
              .sort((a, b) => Number(a.ts - b.ts))
              .map((m) => ({ price: m.price, ts: m.ts }));
            const live = p.entryAvg > 0n ? p.entryAvg : pts.length ? pts[pts.length - 1].price : 0n;
            if (live > 0n) pts.push({ price: live, ts: BigInt(Math.floor(Date.now() / 1000)) });
            return pts;
          })();
          return (            <div className="plan" key={String(p.id)}>
              <div className="plan-head">
                <span className="pid">#{String(p.id)} · {STOCK_NAME[p.stock.toLowerCase()] ?? "STOCK"}</span>
                <span className={`tag ${!p.active ? "off" : p.paused ? "warn" : "ok"}`}>
                  {!p.active ? "closed" : p.paused ? "paused · corp. action" : "active"}
                </span>
              </div>
              {lowFunds && (
                <div className="warnbanner">
                  <strong>Low funds — ≈{String(fillsLeft)} fill{fillsLeft === 1n ? "" : "s"} left.</strong>
                  <span>Top up so the trail never goes quiet mid-judging.</span>
                  <button className="btn primary" onClick={() => topUp(p.id, p.amountPerFill)}>Top up {fmtUSD(p.amountPerFill * 10n, USD_D)}</button>
                </div>
              )}
              <div className="statgrid">
                <div><span>Total value</span><strong className="hero-num">{fmtUSD(total, USD_D)}</strong></div>
                <div><span>Stock held</span><strong>{Number(formatUnits(p.stockBalance, 18)).toFixed(4)}</strong></div>
                <div><span>Avg entry</span><strong>{p.entryAvg > 0n ? fmtPrice(p.entryAvg) : "—"}</strong></div>
                <div><span>Per fill</span><strong>{fmtUSD(p.amountPerFill, USD_D)}</strong></div>
                <div><span>Cadence</span><strong>{String(p.cadenceSec / 60n)} min</strong></div>
                <div><span>Protection</span><strong>−{Number(p.stopLossBps) / 100}% / +{Number(p.takeProfitBps) / 100}%</strong></div>
                <div><span>In earn</span><strong>{fmtUSD(p.equity[3], USD_D)}</strong></div>
                <div><span>Fills left</span><strong className={lowFunds ? "neg" : ""}>≈{String(fillsLeft)}</strong></div>
                <div><span>Last fill</span><strong style={{ fontSize: 16 }}>{p.lastFill > 0n ? fmtTs(p.lastFill) : "—"}</strong></div>
              </div>
              <div className="perfrow">
                <div className="spark">
                  <span>Live price · fills marked</span>
                  <Sparkline data={data} marks={marks} />
                </div>
                <div className="delta">
                  <span>Position P&amp;L · unrealized</span>
                  {delta ? (
                    <strong className={delta.pnl >= 0n ? "pos" : "neg"}>
                      {delta.pnl >= 0n ? "+" : "−"}
                      {fmtUSD(delta.pnl >= 0n ? delta.pnl : -delta.pnl, USD_D)}
                      {" "}
                      ({delta.pct >= 0n ? "+" : "−"}{(Number(delta.pct >= 0n ? delta.pct : -delta.pct) / 100).toFixed(2)}%)
                    </strong>
                  ) : (
                    <strong>—</strong>
                  )}
                </div>
              </div>
              {p.active && (
                <div className="btnrow">
                  <button className="btn primary" onClick={() => poke(p.id)}>Check &amp; execute now</button>
                  {p.usdgBalance > 0n && (
                    <button className="btn" onClick={() => sweep(p.id, p.usdgBalance)}>Sweep idle → earn</button>
                  )}
                  <button className="btn danger" onClick={() => cancel(p.id)}>Cancel &amp; exit</button>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section>
        <div className="sec-head">
          <span className="sec-num">03</span>
          <h2>Verifiable trail</h2>
          <span className="dim">every fill, refusal and protection — onchain</span>
        </div>
        {trail.length === 0 && <p className="empty">No events yet.</p>}
        {trail.slice(safePage * PAGE, safePage * PAGE + PAGE).map((t) => (
          <div className="trail" key={t.key}>
            <span className={`dot ${t.kind}`} />
            <div>
              <strong>{t.label}</strong>
              <span className="dim"> · block {String(t.block)}</span>
              <div className="meta">{t.detail}</div>
              {txLink(t.tx) ? (
                <a href={txLink(t.tx)} target="_blank" rel="noreferrer"><code>{t.tx.slice(0, 18)}…</code></a>
              ) : (
                <code>{t.tx.slice(0, 18)}…</code>
              )}
            </div>
          </div>
        ))}
        {pageCount > 1 && (
          <div className="btnrow pager">
            <button className="btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>← Newer</button>
            <span className="dim small">page {safePage + 1} / {pageCount} · {trail.length} events</span>
            <button className="btn" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Older →</button>
          </div>
        )}
      </section>

      <footer>
        <span>Batpilot · non-custodial stock autopilot</span>
        <span>Guard refuses stale fills — never acts blind</span>
      </footer>
    </div>
  );
}
