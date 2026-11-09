/**
 * Rewards inbox: product-token earnings (VEIL, [HRVST], Cumulus://Cloud, FabriC++ and the rest)
 * that arrived in this wallet, with the product each came from. Read straight from the chain:
 * ERC-20 Transfer logs on Ethereum/Base, and token balance changes on Solana.
 */
import { formatUnits, parseAbiItem, type Address } from "viem";
import { publicClient } from "./evm.ts";
import { associatedTokenAddress, mintInfo, rpc } from "./solana.ts";
import { CHAINS, type ChainKey, type NetworkMode, type TokenInfo } from "./config.ts";

export interface Reward {
  chain: ChainKey;
  product: string;
  symbol: string;
  amount: string;
  from: string;
  tx: string;
  at?: string;
  explorerUrl: string;
}

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export async function evmRewards(mode: NetworkMode, chain: ChainKey, owner: Address, tokens: TokenInfo[], lookbackBlocks = 9_000n): Promise<Reward[]> {
  const client = publicClient(mode, chain);
  const live = tokens.filter((t) => t.infinitum && t.address);
  if (!live.length) return [];
  const latest = await client.getBlockNumber();
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;
  const out: Reward[] = [];
  for (const t of live) {
    try {
      const logs = await client.getLogs({ address: t.address as Address, event: transferEvent, args: { to: owner }, fromBlock, toBlock: latest });
      for (const l of logs) {
        out.push({
          chain, product: t.product ?? "Infinitum", symbol: t.symbol, amount: formatUnits(l.args.value ?? 0n, t.decimals),
          from: l.args.from ?? "", tx: l.transactionHash, explorerUrl: `${CHAINS[mode][chain].explorer}/tx/${l.transactionHash}`,
        });
      }
    } catch {
      // Public RPCs sometimes refuse log ranges; skip that token rather than fail the inbox.
    }
  }
  return out.reverse();
}

export async function solanaRewards(mode: NetworkMode, owner: string, tokens: TokenInfo[], perToken = 10): Promise<Reward[]> {
  const out: Reward[] = [];
  for (const t of tokens.filter((x) => x.infinitum && x.address)) {
    try {
      const mint = await mintInfo(mode, t.address!);
      const ata = associatedTokenAddress(owner, t.address!, mint.program);
      const sigs = await rpc<{ signature: string; blockTime?: number; err: unknown }[]>(mode, "getSignaturesForAddress", [ata, { limit: perToken }]);
      for (const s of sigs.filter((x) => !x.err)) {
        const tx = await rpc<{ meta: { preTokenBalances: Bal[]; postTokenBalances: Bal[] } } | null>(mode, "getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
        if (!tx) continue;
        const delta = balanceDelta(tx.meta.preTokenBalances, tx.meta.postTokenBalances, owner, t.address!);
        if (delta <= 0n) continue;
        out.push({
          chain: "solana", product: t.product ?? "Infinitum", symbol: t.symbol, amount: formatUnits(delta, mint.decimals), from: "",
          tx: s.signature, at: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : undefined,
          explorerUrl: `${CHAINS[mode].solana.explorer}/tx/${s.signature}${mode === "testnet" ? "?cluster=devnet" : ""}`,
        });
      }
    } catch {
      // Token not live or account not opened yet.
    }
  }
  return out;
}

interface Bal {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export function balanceDelta(pre: Bal[], post: Bal[], owner: string, mint: string): bigint {
  const sum = (rows: Bal[]) => rows.filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(post) - sum(pre);
}
