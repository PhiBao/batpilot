import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Testnet demo feeds track live CMC quotes (every 5 min via cron).
// Only touches permissionless mock feeds — never mainnet/real Chainlink.
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

const key = process.env.CMC_API_KEY;
const pk = process.env.TESTNET_KEY;
if (!key || !pk) throw new Error("CMC_API_KEY / TESTNET_KEY required");

const res = await fetch(
  `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=NVDA,TSLA&convert=USD&CMC_PRO_API_KEY=${key}`
);
if (!res.ok) throw new Error(`CMC http ${res.status}`);
const data = await res.json();

const account = privateKeyToAccount(pk);
const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });

for (const symbol of Object.keys(FEEDS)) {
  const price = Number(data?.data?.[symbol]?.quote?.USD?.price);
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
