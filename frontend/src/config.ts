import type { Address } from "viem";

export const VAULT_ABI = [
  { type: "function", name: "planCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "plans", stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" }, { name: "stock", type: "address" },
      { name: "feed", type: "address" }, { name: "amountPerFill", type: "uint256" },
      { name: "cadenceSec", type: "uint256" }, { name: "stopLossBps", type: "uint256" },
      { name: "takeProfitBps", type: "uint256" }, { name: "maxStaleSec", type: "uint256" },
      { name: "bandBps", type: "uint256" }, { name: "usdgBalance", type: "uint256" },
      { name: "stockBalance", type: "uint256" }, { name: "entryAvg", type: "uint256" },
      { name: "lastFill", type: "uint256" }, { name: "uiSnapshot", type: "uint256" },
      { name: "yieldShares", type: "uint256" }, { name: "active", type: "bool" },
      { name: "paused", type: "bool" },
    ],
  },
  {
    type: "function", name: "createPlan", stateMutability: "nonpayable",
    inputs: [
      { name: "stock", type: "address" }, { name: "feed", type: "address" },
      { name: "amountPerFill", type: "uint256" }, { name: "cadenceSec", type: "uint256" },
      { name: "stopLossBps", type: "uint256" }, { name: "takeProfitBps", type: "uint256" },
      { name: "maxStaleSec", type: "uint256" }, { name: "bandBps", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "fundPlan", stateMutability: "nonpayable", inputs: [{ name: "planId", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "executeDCA", stateMutability: "nonpayable", inputs: [{ name: "planId", type: "uint256" }], outputs: [{ name: "executed", type: "bool" }, { name: "reason", type: "uint8" }] },
  { type: "function", name: "executeProtection", stateMutability: "nonpayable", inputs: [{ name: "planId", type: "uint256" }], outputs: [{ name: "code", type: "uint8" }] },
  { type: "function", name: "sweepToYield", stateMutability: "nonpayable", inputs: [{ name: "planId", type: "uint256" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "cancelPlan", stateMutability: "nonpayable", inputs: [{ name: "planId", type: "uint256" }], outputs: [] },
  {
    type: "function", name: "planEquity", stateMutability: "view", inputs: [{ name: "planId", type: "uint256" }],
    outputs: [{ name: "usdg", type: "uint256" }, { name: "stock", type: "uint256" }, { name: "stockValue", type: "uint256" }, { name: "yieldValue", type: "uint256" }],
  },
  { type: "event", name: "PlanCreated", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "owner", type: "address", indexed: true }, { name: "stock", type: "address" }, { name: "amountPerFill", type: "uint256" }] },
  { type: "event", name: "Funded", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "amount", type: "uint256" }] },
  { type: "event", name: "Fill", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "usdgIn", type: "uint256" }, { name: "stockOut", type: "uint256" }, { name: "price", type: "uint256" }, { name: "feedTs", type: "uint256" }] },
  { type: "event", name: "GuardRejected", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "reason", type: "uint8" }, { name: "price", type: "uint256" }, { name: "feedTs", type: "uint256" }] },
  { type: "event", name: "Protected", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "kind", type: "uint8" }, { name: "stockSold", type: "uint256" }, { name: "usdgOut", type: "uint256" }, { name: "price", type: "uint256" }] },
  { type: "event", name: "ProtectionSkipped", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "reason", type: "uint8" }] },
  { type: "event", name: "Swept", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "assets", type: "uint256" }, { name: "shares", type: "uint256" }] },
  { type: "event", name: "CorporateActionPause", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "oldMultiplier", type: "uint256" }, { name: "newMultiplier", type: "uint256" }] },
  { type: "event", name: "Cancelled", inputs: [{ name: "planId", type: "uint256", indexed: true }, { name: "usdgReturned", type: "uint256" }] },
] as const;

export const ERC20_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const env = (k: string, fallback: string) =>
  (import.meta as any).env?.[k] ?? fallback;

export const CFG = {
  chainId: Number(env("VITE_CHAIN_ID", "31337")),
  rpcUrl: env("VITE_RPC_URL", "http://127.0.0.1:8545"),
  vault: env("VITE_VAULT", "0x9A676e781A523b5d0C0e43731313A708CB607508") as Address,
  usdg: env("VITE_USDG", "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512") as Address,
  explorer: env("VITE_EXPLORER", ""),
};

export const STOCKS: { symbol: string; stock: Address; feed: Address; refPrice: string }[] = [
  {
    symbol: "NVDA",
    stock: env("VITE_NVDA", "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9") as Address,
    feed: env("VITE_NVDA_FEED", "0x0165878A594ca255338adfa4d48449f69242Eb8F") as Address,
    refPrice: "$180",
  },
  {
    symbol: "TSLA",
    stock: env("VITE_TSLA", "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707") as Address,
    feed: env("VITE_TSLA_FEED", "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853") as Address,
    refPrice: "$250",
  },
];

export const REASONS = ["OK", "STALE_FEED", "PAUSED", "BAND_BREACH", "INVALID_PRICE"];

export const fmtUSD = (wei: bigint) =>
  "$" + (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 });

export const fmtPrice = (p8: bigint) => "$" + (Number(p8) / 1e8).toFixed(2);

export const fmtTs = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleString();
