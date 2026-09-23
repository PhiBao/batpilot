import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Testnet demo feeds track the live equity market (every 5 min via cron).
// Free Yahoo Finance quotes — no key, no credits to burn. Only touches
// permissionless mock feeds — never mainnet / real Chainlink.
const SYMBOLS = ["NVDA", "TSLA"];
const FEEDS = {
  NVDA: "0x8B21368c3a1D3530DFd7eFAE66173Cb30F4fd42e",
  TSLA: "0x081974a63EF78581f00fde9Ce48f673474eD157C",
};
const RPC = "https://rpc.testnet.chain.robinhood.com";
const CHAIN = {
  id: 46630,
  name: "Robinhood Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const SETPRICE_ABI = [
  { type: "function", name: "setPrice", stateMutability: "nonpayable",
    inputs: [{ name: "p", type: "int256" }], outputs: [] },
];

const pk = process.env.TESTNET_KEY;
if (!pk) throw new Error("TESTNET_KEY required");

const quotes = {};
// v8 chart is per-symbol: one light request each.
for (const symbol of SYMBOLS) {
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
    { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" } }
  );
  if (!r.ok) continue;
  const d = await r.json();
  const m = d?.chart?.result?.[0]?.meta;
  if (m && Number.isFinite(m.regularMarketPrice)) quotes[symbol] = m.regularMarketPrice;
}

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

for (const symbol of Object.keys(FEEDS)) {
  const price = Number(quotes[symbol]);
  if (!Number.isFinite(price) || price <= 1 || price > 1_000_000) {
    console.error(`bad quote for ${symbol}`);
    continue;
  }
  const price8 = BigInt(Math.round(price * 1e8));
  const hash = await wallet.writeContract({
    address: FEEDS[symbol],
    abi: SETPRICE_ABI,
    functionName: "setPrice",
    args: [price8],
    account, // local signer object (sends raw tx — no remote keys needed)
    chain: CHAIN,
  });
  console.log(`${symbol} $${price.toFixed(2)} → ${hash}`);
  await pub.waitForTransactionReceipt({ hash });
}
console.log("sync complete");
