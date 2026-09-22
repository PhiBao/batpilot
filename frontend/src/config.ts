import { defineChain, type Address, type Chain } from "viem";

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

export const FEED_ABI = [
  {
    type: "function", name: "latestRoundData", stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function", name: "getRoundData", stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

export const ERC20_ABI = [  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export type Stock = { symbol: string; stock: Address; feed: Address; refPrice: string };

export type ChainCfg = {
  id: number;
  name: string;
  rpc: string;
  explorer: string;
  vault: Address;
  usdg: Address;
  stocks: Stock[];
  chain: Chain;
  faucetNote: string;
};

const rhc = (
  id: number,
  name: string,
  rpc: string,
  explorer: string,
  vault: Address,
  usdg: Address,
  stocks: Stock[],
  faucetNote: string,
): ChainCfg => ({
  id,
  name,
  rpc,
  explorer,
  vault,
  usdg,
  stocks,
  faucetNote,
  chain: defineChain({
    id,
    name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  }),
});

export const CHAINS: Record<number, ChainCfg> = {
  46630: rhc(
    46630,
    "Robinhood Testnet",
    "https://rpc.testnet.chain.robinhood.com",
    "https://explorer.testnet.chain.robinhood.com",
    "0x9e75555936a2097Ce281De7EFb5CdCC281277BF5",
    "0xDFEcE74f0aDBa3cc18B065DBA0DEc82bE52AA830",
    [
      { symbol: "NVDA", stock: "0x910e17CC1Ea45B824E3Be700430E3F2cD29c5a4E", feed: "0x2777C66CDE6C15D301cd0bf03C302b56E298e431", refPrice: "$180" },
      { symbol: "TSLA", stock: "0xFD842da1854e40c55F19FE63a879CB65cd3B9A28", feed: "0xD6523ac0d3004E57799AA299E68E8788618bA189", refPrice: "$250" },
    ],
    "faucet: faucet.testnet.chain.robinhood.com (ETH + test stocks)",
  ),
  4663: rhc(
    4663,
    "Robinhood Mainnet",
    "https://rpc.mainnet.chain.robinhood.com",
    "https://robin.etherscan.io",
    "0xde7b9F01C566A4f8AdcF57CbFC738E5EA2b7Fa0a",
    "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    [
      { symbol: "NVDA", stock: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", refPrice: "~$180" },
      { symbol: "TSLA", stock: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", feed: "0x4A1166a659A55625345e9515b32adECea5547C38", refPrice: "~$250" },
      { symbol: "AAPL", stock: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", feed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0", refPrice: "~$230" },
    ],
    "real funds — owner-funded alpha, unaudited",
  ),
};

export const DEFAULT_CHAIN = 46630;

export const REASONS = ["OK", "STALE_FEED", "PAUSED", "BAND_BREACH", "INVALID_PRICE"];

export const fmtUSD = (wei: bigint, dec = 18) =>
  "$" + (Number(wei) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 2 });

export const fmtPrice = (p8: bigint) => "$" + (Number(p8) / 1e8).toFixed(2);

export const fmtTs = (ts: bigint) => new Date(Number(ts) * 1000).toLocaleString();
