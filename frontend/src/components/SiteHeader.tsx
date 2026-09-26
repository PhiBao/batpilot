import { Link, useLocation } from "react-router-dom";
import { useAccount, useConnect, useDisconnect } from "wagmi";

export default function SiteHeader() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const loc = useLocation();
  const onAgent = loc.pathname === "/agent";

  return (
    <div className="topbar">
      <div className="brandrow">
        <Link to="/" className="brand">
          BATPILOT<em>RHC</em>
        </Link>
        <nav className="mainnav">
          <Link to="/" className={onAgent ? "" : "on"}>
            App
          </Link>
          <Link to="/agent" className={onAgent ? "on" : ""}>
            Agent
          </Link>
        </nav>
      </div>
      <div className="connect">
        {isConnected ? (
          <>
            <code>
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </code>
            <button className="btn" onClick={() => disconnect()}>
              Disconnect
            </button>
          </>
        ) : (
          <button
            className="btn primary"
            onClick={() => connectors[0] && connect({ connector: connectors[0] })}
          >
            Connect wallet
          </button>
        )}
      </div>
    </div>
  );
}
