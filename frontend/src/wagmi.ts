import { createConfig, http, injected } from "wagmi";
import { CHAINS } from "./config";

const chains = Object.values(CHAINS).map((c) => c.chain) as [any, ...any[]];

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(
    Object.values(CHAINS).map((c) => [c.id, http(c.rpc)])
  ) as any,
});
