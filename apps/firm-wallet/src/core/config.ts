/**
 * $FIRM Wallet™ networks, tokens and Infinitum products.
 *
 * Everything here is free to run: public RPC endpoints, open-source Uniswap V2 routers that
 * already exist on each chain, and the free CoinGecko price API. Any URL can be overridden at
 * build time with a VITE_ variable (see README) without code changes.
 */
export type NetworkMode = "mainnet" | "testnet";
export type ChainKey = "ethereum" | "base" | "solana" | "arbitrum";
export type ChainKind = "evm" | "solana";

/**
 * Testnet stays the default until the wallet has had an external security review. People can
 * switch to mainnet in Settings; the switch says plainly that funds are real.
 */
export const DEFAULT_MODE: NetworkMode = (import.meta.env?.VITE_DEFAULT_MODE as NetworkMode) || "testnet";

export interface ChainConfig {
  key: ChainKey;
  kind: ChainKind;
  name: string;
  /** EVM chain id; for Solana a label only. */
  chainId: number;
  rpcUrl: string;
  explorer: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Uniswap V2-compatible router used for EVM swaps. */
  router?: `0x${string}`;
}

const env = (k: string): string | undefined => (import.meta.env?.[k] as string | undefined) || undefined;

export const CHAINS: Record<NetworkMode, Record<ChainKey, ChainConfig>> = {
  mainnet: {
    ethereum: {
      key: "ethereum", kind: "evm", name: "Ethereum", chainId: 1,
      rpcUrl: env("VITE_RPC_ETHEREUM") ?? "https://ethereum-rpc.publicnode.com",
      explorer: "https://etherscan.io", nativeSymbol: "ETH", nativeDecimals: 18,
      router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    },
    base: {
      key: "base", kind: "evm", name: "Base", chainId: 8453,
      rpcUrl: env("VITE_RPC_BASE") ?? "https://mainnet.base.org",
      explorer: "https://basescan.org", nativeSymbol: "ETH", nativeDecimals: 18,
      router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    },
    arbitrum: {
      key: "arbitrum", kind: "evm", name: "Arbitrum", chainId: 42161,
      rpcUrl: env("VITE_RPC_ARBITRUM") ?? "https://arb1.arbitrum.io/rpc",
      explorer: "https://arbiscan.io", nativeSymbol: "ETH", nativeDecimals: 18,
    },
    solana: {
      key: "solana", kind: "solana", name: "Solana", chainId: 101,
      rpcUrl: env("VITE_RPC_SOLANA") ?? "https://solana-rpc.publicnode.com",
      explorer: "https://solscan.io", nativeSymbol: "SOL", nativeDecimals: 9,
    },
  },
  testnet: {
    ethereum: {
      key: "ethereum", kind: "evm", name: "Ethereum Sepolia", chainId: 11155111,
      rpcUrl: env("VITE_RPC_ETHEREUM_TESTNET") ?? "https://ethereum-sepolia-rpc.publicnode.com",
      explorer: "https://sepolia.etherscan.io", nativeSymbol: "ETH", nativeDecimals: 18,
      router: "0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3",
    },
    base: {
      key: "base", kind: "evm", name: "Base Sepolia", chainId: 84532,
      rpcUrl: env("VITE_RPC_BASE_TESTNET") ?? "https://sepolia.base.org",
      explorer: "https://sepolia.basescan.org", nativeSymbol: "ETH", nativeDecimals: 18,
      router: "0x1689E7B1F10000AE47eBfE339a4f69dECd19F602",
    },
    arbitrum: {
      key: "arbitrum", kind: "evm", name: "Arbitrum Sepolia", chainId: 421614,
      rpcUrl: env("VITE_RPC_ARBITRUM_TESTNET") ?? "https://sepolia-rollup.arbitrum.io/rpc",
      explorer: "https://sepolia.arbiscan.io", nativeSymbol: "ETH", nativeDecimals: 18,
    },
    solana: {
      key: "solana", kind: "solana", name: "Solana Devnet", chainId: 103,
      rpcUrl: env("VITE_RPC_SOLANA_TESTNET") ?? "https://api.devnet.solana.com",
      explorer: "https://solscan.io", nativeSymbol: "SOL", nativeDecimals: 9,
    },
  },
};

/** Chains shown in the wallet. Arbitrum is there to fund Hyperliquid perps with USDC. */
export const CHAIN_KEYS: ChainKey[] = ["ethereum", "base", "solana", "arbitrum"];

export interface TokenInfo {
  chain: ChainKey;
  symbol: string;
  name: string;
  decimals: number;
  /** ERC-20 contract or SPL mint. Absent for the chain's native coin. */
  address?: string;
  /** Infinitum product the token belongs to, for the rewards inbox. */
  product?: string;
  /** CoinGecko id for prices and Conjure Markets. */
  coingecko?: string;
  infinitum?: boolean;
  /** "wrapped" crypto (WBTC, cbBTC, WETH, wSOL) or a tokenized "stock" (xStocks). */
  category?: "wrapped" | "stock";
  /** For wrapped tokens: what it wraps. For stocks: the underlying ticker. */
  underlying?: string;
}

const USDC: Record<NetworkMode, Record<ChainKey, string>> = {
  mainnet: {
    ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  testnet: {
    ethereum: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    base: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    solana: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    arbitrum: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  },
};

/**
 * Wrapped crypto on mainnet. Testnets have no canonical wrapped BTC, so only WETH/wSOL (which
 * wrap the native coin 1:1 on every network) are listed there.
 */
export const WRAPPED: Record<NetworkMode, Partial<Record<ChainKey, TokenInfo[]>>> = {
  mainnet: {
    ethereum: [
      { chain: "ethereum", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", coingecko: "weth", category: "wrapped", underlying: "ETH" },
      { chain: "ethereum", symbol: "WBTC", name: "Wrapped Bitcoin", decimals: 8, address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", coingecko: "wrapped-bitcoin", category: "wrapped", underlying: "BTC" },
      { chain: "ethereum", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", coingecko: "coinbase-wrapped-btc", category: "wrapped", underlying: "BTC" },
    ],
    base: [
      { chain: "base", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x4200000000000000000000000000000000000006", coingecko: "weth", category: "wrapped", underlying: "ETH" },
      { chain: "base", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", coingecko: "coinbase-wrapped-btc", category: "wrapped", underlying: "BTC" },
    ],
    arbitrum: [
      { chain: "arbitrum", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", coingecko: "weth", category: "wrapped", underlying: "ETH" },
    ],
    solana: [
      { chain: "solana", symbol: "wSOL", name: "Wrapped SOL", decimals: 9, address: "So11111111111111111111111111111111111111112", coingecko: "wrapped-solana", category: "wrapped", underlying: "SOL" },
      { chain: "solana", symbol: "cbBTC", name: "Coinbase Wrapped BTC", decimals: 8, address: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", coingecko: "coinbase-wrapped-btc", category: "wrapped", underlying: "BTC" },
    ],
  },
  testnet: {
    ethereum: [{ chain: "ethereum", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14", category: "wrapped", underlying: "ETH" }],
    base: [{ chain: "base", symbol: "WETH", name: "Wrapped Ether", decimals: 18, address: "0x4200000000000000000000000000000000000006", category: "wrapped", underlying: "ETH" }],
    solana: [{ chain: "solana", symbol: "wSOL", name: "Wrapped SOL", decimals: 9, address: "So11111111111111111111111111111111111111112", category: "wrapped", underlying: "SOL" }],
  },
};

/** $FIRM™ and the product tokens. Each pairs with $FIRM™ and USDC in the Infinitum Nexus™. */
export const INFINITUM_TOKENS: { symbol: string; name: string; product: string; decimals: number }[] = [
  { symbol: "FIRM", name: "$FIRM", product: "Firmament Network", decimals: 18 },
  { symbol: "VEIL", name: "$VEIL", product: "VEIL", decimals: 18 },
  { symbol: "HRVST", name: "Harvest", product: "[HRVST]", decimals: 18 },
  { symbol: "ARCT", name: "Architect", product: ":\\ARCHITECT\\", decimals: 18 },
  { symbol: "SPCTR", name: "Spectre", product: "+SPCTR", decimals: 18 },
  { symbol: "SCLV", name: "Scalus", product: "SCALVS.ai", decimals: 18 },
  { symbol: "CMLS", name: "Cumulus", product: "Cumulus://Cloud", decimals: 18 },
  { symbol: "FBRC", name: "Fabric", product: "FabriC++", decimals: 18 },
];

/**
 * Deployed Infinitum token addresses, per mode and chain:
 * VITE_INFINITUM_TOKENS='{"mainnet":{"base":{"FIRM":"0x…"},"solana":{"FIRM":"<mint>"}}}'.
 * Tokens without an address show as "not live yet" and can't be sent or swapped.
 */
export function infinitumAddresses(): Partial<Record<NetworkMode, Partial<Record<ChainKey, Record<string, string>>>>> {
  const raw = env("VITE_INFINITUM_TOKENS");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("VITE_INFINITUM_TOKENS is not valid JSON; ignoring it");
    return {};
  }
}

export function tokensFor(mode: NetworkMode, chain: ChainKey, custom: TokenInfo[] = []): TokenInfo[] {
  const c = CHAINS[mode][chain];
  const deployed = infinitumAddresses()[mode]?.[chain] ?? {};
  const list: TokenInfo[] = [
    { chain, symbol: c.nativeSymbol, name: c.nativeSymbol === "SOL" ? "Solana" : "Ether", decimals: c.nativeDecimals, coingecko: c.nativeSymbol === "SOL" ? "solana" : "ethereum" },
    { chain, symbol: "USDC", name: "USD Coin", decimals: 6, address: USDC[mode][chain], coingecko: "usd-coin" },
    ...INFINITUM_TOKENS.map((t) => ({
      chain,
      symbol: t.symbol,
      name: t.name,
      product: t.product,
      // SPL tokens on Solana usually use 9 decimals; the mint is read on chain before any transfer.
      decimals: chain === "solana" ? 9 : t.decimals,
      address: deployed[t.symbol],
      infinitum: true,
    })),
    ...(WRAPPED[mode][chain] ?? []),
    ...custom.filter((t) => t.chain === chain),
  ];
  return list;
}

export function usdcAddress(mode: NetworkMode, chain: ChainKey): string {
  return USDC[mode][chain];
}

/**
 * Infinitum products that can connect through the VEIL Nexus. Only these origins (and their
 * subdomains) can ask the wallet to connect, sign in or pay.
 */
export const NEXUS_PRODUCTS: { id: string; name: string; hosts: string[] }[] = [
  { id: "veil", name: "VEIL</>", hosts: ["veil.infinitumcorporation.ai"] },
  { id: "cumulus", name: "Cumulus://Cloud", hosts: ["cumuluscloud.app"] },
  { id: "scalvs", name: "SCALVS.ai", hosts: ["scalvs.app"] },
  { id: "architect", name: ":\\ARCHITECT\\", hosts: ["rchtch.app"] },
  { id: "metatron", name: "METATRON¹⁰⁰", hosts: ["mttrn.app"] },
  { id: "firmament", name: "$Firmament Network", hosts: ["firmnetwork.app"] },
  { id: "infinitum", name: "Infinitum Corporation", hosts: ["infinitumcorporation.ai"] },
  ...(env("VITE_EXTRA_NEXUS_HOSTS") ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => ({ id: h, name: h, hosts: [h] })),
];

/** Hyperliquid perps (open HTTP API, signed with the wallet's own EVM key). */
export const HYPERLIQUID_API: Record<NetworkMode, string> = {
  mainnet: env("VITE_HYPERLIQUID_API") ?? "https://api.hyperliquid.xyz",
  testnet: env("VITE_HYPERLIQUID_API_TESTNET") ?? "https://api.hyperliquid-testnet.xyz",
};
/** Hyperliquid's USDC bridge on Arbitrum (deposits of 5 USDC or more). */
export const HYPERLIQUID_BRIDGE: Record<NetworkMode, `0x${string}`> = {
  mainnet: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
  testnet: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89",
};
/** Derive (formerly Lyra) options: public market data API. */
export const DERIVE_API: Record<NetworkMode, string> = {
  mainnet: env("VITE_DERIVE_API") ?? "https://api.lyra.finance",
  testnet: env("VITE_DERIVE_API_TESTNET") ?? "https://api-demo.lyra.finance",
};
export const DERIVE_APP: Record<NetworkMode, string> = {
  mainnet: "https://www.derive.xyz",
  testnet: "https://testnet.derive.xyz",
};

/**
 * Tokenized stocks, perps and options: the venues' own terms exclude some people (for example US
 * persons and sanctioned regions). The wallet does no location checks; instead it asks the person
 * once, on the device, to confirm they're allowed to use these markets under each venue's terms.
 */
export const VENUE_TERMS = [
  { name: "xStocks (Backed Finance)", url: "https://xstocks.com" },
  { name: "Hyperliquid", url: "https://hyperliquid.xyz" },
  { name: "Derive", url: "https://www.derive.xyz" },
];

export const PRICE_API = env("VITE_PRICE_API") ?? "https://api.coingecko.com/api/v3";
/** Jupiter's free swap API for Solana routes. */
export const JUPITER_API = env("VITE_JUPITER_API") ?? "https://lite-api.jup.ag/swap/v1";
/** Optional: the wallet Worker's proxy to the Conjure swarm (opt-in; uses paid model calls). */
export const CONJURE_SWARM = env("VITE_CONJURE_SWARM") === "1";
