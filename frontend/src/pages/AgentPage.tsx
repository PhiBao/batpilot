import { Link } from "react-router-dom";
import SiteHeader from "../components/SiteHeader";
import {
  AGENT_ID,
  AGENT_WALLET,
  OPENSERV_CONSOLE,
  SERV_AGENT_DIR,
  WHY,
  useAgentFootprint,
} from "../hooks/useAgentFootprint";
import { CHAINS, fmtUSD } from "../config";

const PROMPTS = [
  "Buy 8 dollars of NVDA every 15 minutes, stop me out at minus 8 percent",
  "How is my plan 1 doing?",
  "Why was that fill refused?",
];

export default function AgentPage() {
  const { agentPlans, refusal } = useAgentFootprint(0);
  const mc = CHAINS[4663];

  return (
    <div className="page">
      <SiteHeader />

      <header className="hero">
        <h1>
          Run your own <span className="accent">autopilot agent</span>.
        </h1>
        <p className="lede">
          A SERV agent that turns plain English into protected stock plans on Robinhood
          Chain mainnet — and explains every decision, including the fills it refuses.
          Ours is live now; this page shows you how to launch yours.
        </p>
      </header>

      <section>
        <div className="sec-head">
          <span className="sec-num">01</span>
          <h2>Proof: ours is trading</h2>
          <span className="dim">agent {AGENT_ID} · live onchain footprint</span>
        </div>
        <div className="howstrip">
          <div>
            <strong>Wallet</strong>
            <span>
              <code>{AGENT_WALLET.slice(0, 10)}…</code>{" "}
              <a href={`${mc.explorer}/address/${AGENT_WALLET}`} target="_blank" rel="noreferrer">
                explorer
              </a>
            </span>
          </div>
          <div>
            <strong>Plans it owns</strong>
            <span>
              {agentPlans.length === 0
                ? "none yet"
                : agentPlans
                    .map((p) => `#${String(p.id)} ${p.sym} · ${fmtUSD(p.total, 6)}`)
                    .join(" · ")}
            </span>
          </div>
          <div>
            <strong>Latest guard decision</strong>
            <span>
              {!refusal
                ? "every fill went through cleanly"
                : `refused plan #${refusal.planId} — ${WHY[refusal.reason] ?? "no action needed"}`}
            </span>
          </div>
        </div>
        {agentPlans.length > 0 && (
          <div style={{ marginTop: 18 }}>
            {agentPlans.map((p) => (
              <div className="trail" key={String(p.id)}>
                <span className={`dot ${p.active ? "fill" : "info"}`} />
                <div>
                  <strong>
                    Plan #{String(p.id)} · {p.sym}
                  </strong>
                  <span className="dim">
                    {" "}
                    · {p.active ? "active" : "closed"} · worth {fmtUSD(p.total, 6)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {refusal && (
          <div className="trail" key={refusal.tx}>
            <span className="dot refuse" />
            <div>
              <strong>
                Refused — plan #{refusal.planId} ({refusal.chain})
              </strong>
              <div className="meta">
                {WHY[refusal.reason] ?? "no action needed"}{" "}
                {refusal.feedTs > 0n && <>· feed time {new Date(Number(refusal.feedTs) * 1000).toLocaleString()}</>}
              </div>
              <a href={`${refusal.explorer}/tx/${refusal.tx}`} target="_blank" rel="noreferrer">
                <code>{refusal.tx.slice(0, 18)}…</code>
              </a>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="sec-head">
          <span className="sec-num">02</span>
          <h2>Launch yours in ten minutes</h2>
          <span className="dim">same code ours runs · serv-agent/</span>
        </div>
        <div className="panel">
          <h3 className="agentsub" style={{ marginTop: 0 }}>
            1 · Get a SERV account
          </h3>
          <p className="planstory">
            Sign up at <a href={OPENSERV_CONSOLE}>console.openserv.ai</a>, grab the free
            credit (about a dollar is plenty — the agent uses the cheapest model), and tick
            the data-collection opt-in under organization settings. The hackathon requires it.
          </p>
          <h3 className="agentsub">2 · Clone and install</h3>
          <pre className="codeblock">
            git clone https://github.com/PhiBao/batpilot{"\n"}cd batpilot/serv-agent && pnpm
            install
          </pre>
          <h3 className="agentsub">3 · Fund a fresh trading key</h3>
          <p className="planstory">
            Generate a <strong>brand-new key</strong> — never reuse a deployer. Send it about{" "}
            <strong>$20 in USDG + a little ETH for gas</strong> on Robinhood Chain mainnet,
            and put it in <code>.env</code> as <code>RHC_KEY</code>. The agent can only spend
            what this wallet holds, and code caps each plan at $10.
          </p>
          <h3 className="agentsub">4 · Provision and run</h3>
          <pre className="codeblock">
            npx tsx src/agent.ts{"\n"}# registers the agent, opens a webhook, connects a tunnel
          </pre>
          <p className="planstory">
            Provisioning prints a webhook URL. Chatting needs <strong>no wallet</strong> —
            only the trading key you funded moves money, and only into plans the agent just
            created.
          </p>
          <h3 className="agentsub">5 · Say what you want</h3>
          <div className="btnrow" style={{ marginBottom: 12 }}>
            {PROMPTS.map((p) => (
              <code key={p} className="promptchip">
                {p}
              </code>
            ))}
          </div>
          <p className="planstory">
            Three capabilities: <strong>create plans</strong> from intent,{" "}
            <strong>report status</strong> in words, <strong>explain refusals</strong> with
            receipts. Testnet rehearsals share the exact guard bytecode, so a refusal you
            rehearse behaves identically on mainnet — where it guards real money.
          </p>
        </div>
      </section>

      <section>
        <div className="sec-head">
          <span className="sec-num">03</span>
          <h2>Build on it</h2>
          <span className="dim">open source · MIT</span>
        </div>
        <div className="btnrow">
          <a href={SERV_AGENT_DIR} target="_blank" rel="noreferrer">
            <button className="btn primary">serv-agent/ source</button>
          </a>
          <Link to="/">
            <button className="btn">Back to the app</button>
          </Link>
        </div>
      </section>

      <footer>
        <span>Batpilot · non-custodial stock autopilot</span>
        <span>Guard refuses stale fills — never acts blind</span>
      </footer>
    </div>
  );
}
