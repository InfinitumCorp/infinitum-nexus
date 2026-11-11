/**
 * Ethereum, Base and Arbitrum: balances, sends, WETH wrap/unwrap and Uniswap V2 swaps through
 * the Infinitum Nexus™ (direct, via $FIRM™, or via USDC, whichever gives more out).
 * Built on viem (MIT). Every write returns a prepared request first; the UI shows it for approval
 * and only then calls `execute`.
 */
import {
  createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http, isAddress,
  parseAbi, parseUnits, type Address, type Chain, type Hex, type PublicClient,
} from "viem";
import type { HDAccount } from "viem/accounts";
import { CHAINS, type ChainKey, type NetworkMode, type TokenInfo } from "./config.ts";

const routerAbi = parseAbi([
  "function WETH() view returns (address)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)",
  "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
]);
const wethAbi = parseAbi(["function deposit() payable", "function withdraw(uint wad)"]);

export function viemChain(mode: NetworkMode, key: ChainKey): Chain {
  const c = CHAINS[mode][key];
  return {
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: "Ether", symbol: c.nativeSymbol, decimals: c.nativeDecimals },
    rpcUrls: { default: { http: [c.rpcUrl] } },
    blockExplorers: { default: { name: "Explorer", url: c.explorer } },
  };
}

const clients = new Map<string, PublicClient>();
export function publicClient(mode: NetworkMode, key: ChainKey): PublicClient {
  const id = `${mode}:${key}`;
  let c = clients.get(id);
  if (!c) {
    c = createPublicClient({ chain: viemChain(mode, key), transport: http(CHAINS[mode][key].rpcUrl, { retryCount: 2 }) });
    clients.set(id, c);
  }
  return c;
}

export async function evmBalances(mode: NetworkMode, key: ChainKey, owner: Address, tokens: TokenInfo[]): Promise<Record<string, bigint>> {
  const client = publicClient(mode, key);
  const out: Record<string, bigint> = {};
  await Promise.all(
    tokens.map(async (t) => {
      try {
        if (!t.address) {
          if (!t.infinitum) out[t.symbol] = await client.getBalance({ address: owner });
          return;
        }
        out[t.symbol] = await client.readContract({ address: t.address as Address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      } catch {
        // A token that fails to read is shown as unavailable rather than zero.
      }
    }),
  );
  return out;
}

/** A transaction ready for the approval screen. */
export interface PreparedEvmTx {
  chain: ChainKey;
  mode: NetworkMode;
  kind: "send" | "wrap" | "unwrap" | "approve" | "swap" | "deposit";
  title: string;
  /** Plain-language lines shown before signing. */
  details: [string, string][];
  to: Address;
  data?: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Network fee at the max price, in native units. */
  feeWei: bigint;
}

async function prepare(
  mode: NetworkMode, key: ChainKey, from: Address,
  base: Pick<PreparedEvmTx, "kind" | "title" | "details" | "to" | "data" | "value">,
): Promise<PreparedEvmTx> {
  const client = publicClient(mode, key);
  const [gasEst, fees] = await Promise.all([
    client.estimateGas({ account: from, to: base.to, data: base.data, value: base.value }),
    client.estimateFeesPerGas(),
  ]);
  const gas = (gasEst * 12n) / 10n; // 20% headroom
  const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
  const feeWei = gas * maxFeePerGas;
  const c = CHAINS[mode][key];
  return {
    ...base, chain: key, mode, gas, maxFeePerGas, maxPriorityFeePerGas, feeWei,
    details: [...base.details, ["Network", c.name], ["Max network fee", `${trim(formatUnits(feeWei, 18))} ${c.nativeSymbol}`]],
  };
}

export function trim(n: string, max = 6): string {
  if (!n.includes(".")) return n;
  const [w, f] = n.split(".");
  const t = f!.slice(0, max).replace(/0+$/, "");
  return t ? `${w}.${t}` : w!;
}

export async function prepareSend(mode: NetworkMode, key: ChainKey, from: Address, token: TokenInfo, to: string, amount: string): Promise<PreparedEvmTx> {
  if (!isAddress(to)) throw new Error("That isn't a valid address for this network.");
  const units = parseUnits(amount, token.decimals);
  if (units <= 0n) throw new Error("Enter an amount above zero.");
  const details: [string, string][] = [["To", to], ["Amount", `${amount} ${token.symbol}`]];
  if (!token.address) return prepare(mode, key, from, { kind: "send", title: `Send ${token.symbol}`, details, to: to as Address, value: units });
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, units] });
  return prepare(mode, key, from, { kind: "send", title: `Send ${token.symbol}`, details: [...details, ["Token contract", token.address]], to: token.address as Address, data, value: 0n });
}

export async function prepareWrap(mode: NetworkMode, key: ChainKey, from: Address, weth: TokenInfo, amount: string, direction: "wrap" | "unwrap"): Promise<PreparedEvmTx> {
  const units = parseUnits(amount, 18);
  if (units <= 0n) throw new Error("Enter an amount above zero.");
  const wrap = direction === "wrap";
  return prepare(mode, key, from, {
    kind: direction,
    title: wrap ? "Wrap ETH to WETH" : "Unwrap WETH to ETH",
    details: [["Amount", `${amount} ${wrap ? "ETH → WETH" : "WETH → ETH"}`], ["Rate", "1:1, no fee"], ["WETH contract", weth.address!]],
    to: weth.address as Address,
    data: wrap ? encodeFunctionData({ abi: wethAbi, functionName: "deposit" }) : encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [units] }),
    value: wrap ? units : 0n,
  });
}

/** USDC deposit to a bridge contract (Hyperliquid funding on Arbitrum). */
export async function prepareDeposit(mode: NetworkMode, key: ChainKey, from: Address, usdc: TokenInfo, bridge: Address, amount: string, label: string): Promise<PreparedEvmTx> {
  const units = parseUnits(amount, usdc.decimals);
  return prepare(mode, key, from, {
    kind: "deposit",
    title: label,
    details: [["Amount", `${amount} USDC`], ["Bridge contract", bridge]],
    to: usdc.address as Address,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [bridge, units] }),
    value: 0n,
  });
}

export async function execute(account: HDAccount, tx: PreparedEvmTx): Promise<Hex> {
  const chain = viemChain(tx.mode, tx.chain);
  const wallet = createWalletClient({ account, chain, transport: http(CHAINS[tx.mode][tx.chain].rpcUrl) });
  return wallet.sendTransaction({
    to: tx.to, data: tx.data, value: tx.value, gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, chain,
  });
}

export async function waitFor(mode: NetworkMode, key: ChainKey, hash: Hex) {
  return publicClient(mode, key).waitForTransactionReceipt({ hash, timeout: 180_000 });
}

/* ---------------- Swaps ---------------- */

export interface EvmQuote {
  chain: ChainKey;
  path: Address[];
  route: string;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  native: "in" | "out" | null;
}

/** Candidate routes: direct, through $FIRM™ (the Nexus hub), and through USDC. */
export function candidatePaths(tin: Address, tout: Address, hubs: Address[]): Address[][] {
  const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
  const paths: Address[][] = [[tin, tout]];
  for (const h of hubs) if (!same(h, tin) && !same(h, tout)) paths.push([tin, h, tout]);
  return paths;
}

export async function quoteEvm(
  mode: NetworkMode, key: ChainKey, tokenIn: TokenInfo, tokenOut: TokenInfo, amount: string, slippageBps: number,
  hubs: { symbol: string; address: Address }[],
): Promise<EvmQuote> {
  const router = CHAINS[mode][key].router;
  if (!router) throw new Error(`No swap router on ${CHAINS[mode][key].name}.`);
  const client = publicClient(mode, key);
  const weth = await client.readContract({ address: router, abi: routerAbi, functionName: "WETH" });
  const addr = (t: TokenInfo) => (t.address ?? weth) as Address;
  const amountIn = parseUnits(amount, tokenIn.decimals);
  if (amountIn <= 0n) throw new Error("Enter an amount above zero.");
  let best: { path: Address[]; out: bigint } | null = null;
  for (const path of candidatePaths(addr(tokenIn), addr(tokenOut), hubs.map((h) => h.address))) {
    try {
      const amounts = await client.readContract({ address: router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path] });
      const out = amounts[amounts.length - 1]!;
      if (!best || out > best.out) best = { path, out };
    } catch {
      // No pool for this path.
    }
  }
  if (!best || best.out === 0n) throw new Error(`No liquidity to swap ${tokenIn.symbol} for ${tokenOut.symbol} on ${CHAINS[mode][key].name} yet.`);
  const names = best.path.map((a) => hubs.find((h) => h.address.toLowerCase() === a.toLowerCase())?.symbol ?? (a === addr(tokenIn) ? tokenIn.symbol : tokenOut.symbol));
  return {
    chain: key, path: best.path, route: names.join(" → "), amountIn, amountOut: best.out,
    minOut: (best.out * BigInt(10_000 - slippageBps)) / 10_000n,
    native: !tokenIn.address ? "in" : !tokenOut.address ? "out" : null,
  };
}

/** Approval (if needed) and the swap itself, each shown for approval in turn. */
export async function prepareSwap(mode: NetworkMode, key: ChainKey, from: Address, q: EvmQuote, tokenIn: TokenInfo, tokenOut: TokenInfo): Promise<PreparedEvmTx[]> {
  const router = CHAINS[mode][key].router!;
  const client = publicClient(mode, key);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const txs: PreparedEvmTx[] = [];
  if (q.native !== "in") {
    const allowance = await client.readContract({ address: q.path[0]!, abi: erc20Abi, functionName: "allowance", args: [from, router] });
    if (allowance < q.amountIn) {
      txs.push(await prepare(mode, key, from, {
        kind: "approve",
        title: `Allow the swap to use ${tokenIn.symbol}`,
        details: [["Spender", `Uniswap V2 router ${router}`], ["Allowance", `${formatUnits(q.amountIn, tokenIn.decimals)} ${tokenIn.symbol} (this swap only)`]],
        to: q.path[0]!,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, q.amountIn] }),
        value: 0n,
      }));
    }
  }
  const data = q.native === "in"
    ? encodeFunctionData({ abi: routerAbi, functionName: "swapExactETHForTokens", args: [q.minOut, q.path, from, deadline] })
    : q.native === "out"
      ? encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForETH", args: [q.amountIn, q.minOut, q.path, from, deadline] })
      : encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForTokens", args: [q.amountIn, q.minOut, q.path, from, deadline] });
  const base = {
    kind: "swap" as const,
    title: `Swap ${tokenIn.symbol} for ${tokenOut.symbol}`,
    details: [
      ["You pay", `${formatUnits(q.amountIn, tokenIn.decimals)} ${tokenIn.symbol}`],
      ["You get at least", `${trim(formatUnits(q.minOut, tokenOut.decimals))} ${tokenOut.symbol}`],
      ["Route", `${q.route} (Infinitum Nexus™)`],
      ["Swap fee", "Pool fee only. Infinitum adds no fee."],
    ] as [string, string][],
    to: router,
    data,
    value: q.native === "in" ? q.amountIn : 0n,
  };
  // Gas can't be estimated before the approval lands; use a safe fixed limit in that case.
  if (txs.length) {
    const fees = await client.estimateFeesPerGas();
    const gas = 350_000n;
    const maxFeePerGas = fees.maxFeePerGas ?? 0n;
    txs.push({ ...base, chain: key, mode, gas, maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n, feeWei: gas * maxFeePerGas,
      details: [...base.details, ["Network", CHAINS[mode][key].name], ["Max network fee", `${trim(formatUnits(gas * maxFeePerGas, 18))} ETH`]] });
  } else {
    txs.push(await prepare(mode, key, from, base));
  }
  return txs;
}
