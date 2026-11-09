/**
 * Solana: balances (SOL, SPL and Token-2022, which tokenized stocks use), SOL and token sends,
 * and signing Jupiter swap transactions. Written directly on @noble/@scure (MIT) so the wallet
 * stays small; every transaction is built here byte by byte and signed on the device.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { CHAINS, JUPITER_API, type NetworkMode, type TokenInfo } from "./config.ts";
import type { SolanaKeypair } from "./keys.ts";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export async function rpc<T>(mode: NetworkMode, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(CHAINS[mode].solana.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Solana RPC ${res.status}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

/* ---------------- Encoding ---------------- */

export function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) return out;
  }
}

export function readCompactU16(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let size = 0;
  for (;;) {
    const b = bytes[offset + size]!;
    value |= (b & 0x7f) << (7 * size);
    size++;
    if (!(b & 0x80)) return [value, size];
  }
}

const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Program-derived address (findProgramAddress). */
export function findPda(seeds: Uint8Array[], programId: string): [string, number] {
  const program = base58.decode(programId);
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, marker];
    const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = sha256(buf);
    if (!isOnCurve(hash)) return [base58.encode(hash), bump];
  }
  throw new Error("no program address found");
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findPda([base58.decode(owner), base58.decode(tokenProgram), base58.decode(mint)], ATA_PROGRAM)[0];
}

export interface AccountMeta {
  pubkey: string;
  signer: boolean;
  writable: boolean;
}
export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

/** Compile a legacy message: fee payer first, then signers, then the rest, writable before read-only. */
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): Uint8Array {
  const metas = new Map<string, AccountMeta>();
  const add = (m: AccountMeta) => {
    const e = metas.get(m.pubkey);
    if (e) {
      e.signer ||= m.signer;
      e.writable ||= m.writable;
    } else metas.set(m.pubkey, { ...m });
  };
  add({ pubkey: feePayer, signer: true, writable: true });
  for (const ix of instructions) {
    ix.keys.forEach(add);
    add({ pubkey: ix.programId, signer: false, writable: false });
  }
  const rank = (m: AccountMeta) => (m.pubkey === feePayer ? 0 : m.signer ? (m.writable ? 1 : 2) : m.writable ? 3 : 4);
  const ordered = [...metas.values()].sort((a, b) => rank(a) - rank(b));
  const index = new Map(ordered.map((m, i) => [m.pubkey, i]));
  const signers = ordered.filter((m) => m.signer);
  const header = [signers.length, signers.filter((m) => !m.writable).length, ordered.filter((m) => !m.signer && !m.writable).length];
  const bytes: number[] = [...header, ...compactU16(ordered.length)];
  for (const m of ordered) bytes.push(...base58.decode(m.pubkey));
  bytes.push(...base58.decode(recentBlockhash));
  bytes.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    bytes.push(index.get(ix.programId)!);
    bytes.push(...compactU16(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!));
    bytes.push(...compactU16(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(bytes);
}

export function signLegacy(message: Uint8Array, kp: SolanaKeypair): Uint8Array {
  const sig = kp.sign(message);
  return Uint8Array.from([...compactU16(1), ...sig, ...message]);
}

/**
 * Sign a serialized (legacy or v0) transaction from a swap API. Refuses unless this wallet is
 * the fee payer, so a crafted transaction can't spend from it as a hidden second signer.
 */
export function signSerialized(tx: Uint8Array, kp: SolanaKeypair): Uint8Array {
  const [nSigs, len] = readCompactU16(tx, 0);
  const msgStart = len + nSigs * 64;
  const message = tx.slice(msgStart);
  const versioned = (message[0]! & 0x80) !== 0;
  const keysAt = (versioned ? 1 : 0) + 3;
  const [, klen] = readCompactU16(message, keysAt);
  const payer = base58.encode(message.slice(keysAt + klen, keysAt + klen + 32));
  if (payer !== kp.address) throw new Error("This transaction isn't paid for by your wallet, so it wasn't signed.");
  const out = tx.slice();
  out.set(kp.sign(message), len);
  return out;
}

/* ---------------- Reads ---------------- */

export interface SplHolding {
  mint: string;
  program: string;
  account: string;
  amount: bigint;
  decimals: number;
}

export async function solBalance(mode: NetworkMode, owner: string): Promise<bigint> {
  const r = await rpc<{ value: number }>(mode, "getBalance", [owner, { commitment: "confirmed" }]);
  return BigInt(r.value);
}

export async function splHoldings(mode: NetworkMode, owner: string): Promise<SplHolding[]> {
  const out: SplHolding[] = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const r = await rpc<{ value: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } }[] }>(
      mode, "getTokenAccountsByOwner", [owner, { programId: program }, { encoding: "jsonParsed", commitment: "confirmed" }],
    );
    for (const a of r.value) {
      const info = a.account.data.parsed.info;
      out.push({ mint: info.mint, program, account: a.pubkey, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals });
    }
  }
  return out;
}

export async function mintInfo(mode: NetworkMode, mint: string): Promise<{ decimals: number; program: string }> {
  const r = await rpc<{ value: { owner: string; data: { parsed: { info: { decimals: number } } } } | null }>(mode, "getAccountInfo", [mint, { encoding: "jsonParsed" }]);
  if (!r.value) throw new Error("That token doesn't exist on this network.");
  return { decimals: r.value.data.parsed.info.decimals, program: r.value.owner };
}

async function blockhash(mode: NetworkMode): Promise<string> {
  const r = await rpc<{ value: { blockhash: string } }>(mode, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  return r.value.blockhash;
}

/* ---------------- Writes ---------------- */

export interface PreparedSolTx {
  chain: "solana";
  mode: NetworkMode;
  kind: "send" | "swap";
  title: string;
  details: [string, string][];
  /** Builds and signs with a fresh blockhash at the moment of approval. */
  build(kp: SolanaKeypair): Promise<Uint8Array>;
}

export function parseUnitsBig(amount: string, decimals: number): bigint {
  const t = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Enter an amount like 1.5");
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) throw new Error(`Up to ${decimals} decimals.`);
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

export async function prepareSolSend(mode: NetworkMode, from: string, token: TokenInfo, to: string, amount: string): Promise<PreparedSolTx> {
  let toBytes: Uint8Array;
  try {
    toBytes = base58.decode(to);
  } catch {
    throw new Error("That isn't a valid Solana address.");
  }
  if (toBytes.length !== 32) throw new Error("That isn't a valid Solana address.");
  const details: [string, string][] = [["To", to], ["Amount", `${amount} ${token.symbol}`], ["Network", CHAINS[mode].solana.name], ["Network fee", "about 0.000005 SOL"]];

  if (!token.address || token.address === WSOL_MINT && token.symbol === "SOL") {
    const lamports = parseUnitsBig(amount, 9);
    if (lamports <= 0n) throw new Error("Enter an amount above zero.");
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    data.set(u64(lamports), 4);
    const ix: Instruction = { programId: SYSTEM_PROGRAM, keys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }], data };
    return { chain: "solana", mode, kind: "send", title: "Send SOL", details, build: async (kp) => signLegacy(compileMessage(from, [ix], await blockhash(mode)), kp) };
  }

  const mint = await mintInfo(mode, token.address);
  const units = parseUnitsBig(amount, mint.decimals);
  if (units <= 0n) throw new Error("Enter an amount above zero.");
  const src = associatedTokenAddress(from, token.address, mint.program);
  const dst = associatedTokenAddress(to, token.address, mint.program);
  const createAta: Instruction = {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: from, signer: true, writable: true },
      { pubkey: dst, signer: false, writable: true },
      { pubkey: to, signer: false, writable: false },
      { pubkey: token.address, signer: false, writable: false },
      { pubkey: SYSTEM_PROGRAM, signer: false, writable: false },
      { pubkey: mint.program, signer: false, writable: false },
    ],
    data: Uint8Array.of(1), // CreateIdempotent: no-op if the account already exists
  };
  const transfer: Instruction = {
    programId: mint.program,
    keys: [
      { pubkey: src, signer: false, writable: true },
      { pubkey: token.address, signer: false, writable: false },
      { pubkey: dst, signer: false, writable: true },
      { pubkey: from, signer: true, writable: false },
    ],
    data: Uint8Array.from([12, ...u64(units), mint.decimals]), // TransferChecked
  };
  return {
    chain: "solana", mode, kind: "send", title: `Send ${token.symbol}`,
    details: [...details, ["Token mint", token.address], ["Note", "Opens the recipient's token account if they don't have one (about 0.002 SOL)."]],
    build: async (kp) => signLegacy(compileMessage(from, [createAta, transfer], await blockhash(mode)), kp),
  };
}

export async function sendSigned(mode: NetworkMode, signed: Uint8Array): Promise<string> {
  return rpc<string>(mode, "sendTransaction", [base64.encode(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);
}

export async function confirm(mode: NetworkMode, signature: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(mode, "getSignatureStatuses", [[signature]]);
    const s = r.value[0];
    if (s?.err) throw new Error("The transaction failed on chain.");
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("Still waiting for confirmation. Check the explorer.");
}

/* ---------------- Jupiter swaps (mainnet) ---------------- */

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
  [k: string]: unknown;
}

export async function quoteJupiter(mode: NetworkMode, inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupQuote> {
  if (mode !== "mainnet") throw new Error("Solana swaps run on mainnet only (Jupiter has no devnet routes). Switch to mainnet in Settings.");
  const u = new URL(`${JUPITER_API}/quote`);
  u.search = new URLSearchParams({ inputMint, outputMint, amount: amount.toString(), slippageBps: String(slippageBps), restrictIntermediateTokens: "true" }).toString();
  const res = await fetch(u);
  const json = (await res.json()) as JupQuote & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? "No route for this swap right now.");
  return json;
}

export function prepareJupiterSwap(mode: NetworkMode, owner: string, quote: JupQuote, tin: TokenInfo, tout: TokenInfo, inDecimals: number, outDecimals: number): PreparedSolTx {
  const fmt = (v: string, d: number) => {
    const n = BigInt(v);
    const w = n / 10n ** BigInt(d);
    const f = (n % 10n ** BigInt(d)).toString().padStart(d, "0").slice(0, 6).replace(/0+$/, "");
    return f ? `${w}.${f}` : `${w}`;
  };
  const venues = [...new Set(quote.routePlan.map((r) => r.swapInfo.label).filter(Boolean))].join(", ");
  return {
    chain: "solana", mode, kind: "swap",
    title: `Swap ${tin.symbol} for ${tout.symbol}`,
    details: [
      ["You pay", `${fmt(quote.inAmount, inDecimals)} ${tin.symbol}`],
      ["You get at least", `${fmt(quote.otherAmountThreshold, outDecimals)} ${tout.symbol}`],
      ["Price impact", `${(Number(quote.priceImpactPct) * 100).toFixed(2)}%`],
      ["Route", venues ? `Jupiter via ${venues}` : "Jupiter"],
      ["Swap fee", "Pool fees only. Infinitum adds no fee."],
    ],
    async build(kp) {
      const res = await fetch(`${JUPITER_API}/swap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
      });
      const json = (await res.json()) as { swapTransaction?: string; error?: string };
      if (!json.swapTransaction) throw new Error(json.error ?? "The swap couldn't be built.");
      return signSerialized(base64.decode(json.swapTransaction), kp);
    },
  };
}
