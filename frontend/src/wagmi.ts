import { createConfig, http, injected } from "wagmi";
import { defineChain } from "viem";
import { CFG } from "./config";

export const batpilotChain = defineChain({
  id: CFG.chainId,
  name: CFG.chainId === 31337 ? "Batpilot Local" : "Batpilot Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CFG.rpcUrl] } },
});

export const wagmiConfig = createConfig({
  chains: [batpilotChain],
  connectors: [injected()],
  transports: { [batpilotChain.id]: http(CFG.rpcUrl) },
});
