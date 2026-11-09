/**
 * VEIL Nexus connections: how Cumulus://Cloud, SCALVS.ai, :\ARCHITECT\, METATRON¹⁰⁰ and the other
 * Infinitum products sign people in, ask for payment and get approvals from $FIRM Wallet™.
 *
 * A product opens  https://firmwallet.app/#/connect?origin=<its https origin>&nonce=<random>
 *            or    https://firmwallet.app/#/pay?origin=…&chain=base&asset=USDC&to=0x…&amount=12.5&memo=…
 * The wallet only answers origins on the Infinitum product list, shows exactly what is being
 * approved, and replies with window.postMessage to that exact origin (never "*").
 * Sign-in uses Sign-In with Ethereum (EIP-4361), so any product backend can verify it.
 */
import { createSiweMessage, generateSiweNonce } from "viem/siwe";
import type { Address } from "viem";
import { CHAINS, NEXUS_PRODUCTS, type ChainKey, type NetworkMode } from "./config.ts";

export interface NexusProduct {
  id: string;
  name: string;
  origin: string;
}

export function productForOrigin(origin: string, allowLocal = false): NexusProduct | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null; // no paths, no credentials
  const local = allowLocal && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !local) return null;
  if (local) return { id: "local", name: `Local dev (${u.host})`, origin };
  const host = u.hostname.toLowerCase();
  for (const p of NEXUS_PRODUCTS) {
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { id: p.id, name: p.name, origin };
  }
  return null;
}

export interface ConnectRequest {
  type: "connect";
  product: NexusProduct;
  nonce: string;
  chain: ChainKey;
  statement: string;
}

export interface PayRequest {
  type: "pay";
  product: NexusProduct;
  chain: ChainKey;
  asset: string;
  to: string;
  amount: string;
  memo: string;
  requestId: string;
}

export type NexusRequest = ConnectRequest | PayRequest;

export function parseRequest(hash: string, allowLocal = false): NexusRequest | { error: string } | null {
  const m = /^#\/(connect|pay)\?(.*)$/.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[2]);
  const product = productForOrigin(q.get("origin") ?? "", allowLocal);
  if (!product) return { error: "This request didn't come from an Infinitum product, so the wallet won't answer it." };
  const chain = (q.get("chain") ?? "base") as ChainKey;
  if (!["ethereum", "base", "solana", "arbitrum"].includes(chain)) return { error: "Unknown network in the request." };
  if (m[1] === "connect") {
    const nonce = q.get("nonce") ?? "";
    if (!/^[a-zA-Z0-9]{8,64}$/.test(nonce)) return { error: "The sign-in request is missing a valid nonce." };
    return { type: "connect", product, nonce, chain, statement: `Sign in to ${product.name} with $FIRM Wallet.` };
  }
  const amount = q.get("amount") ?? "";
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) return { error: "The payment request has no valid amount." };
  return {
    type: "pay", product, chain, asset: (q.get("asset") ?? "USDC").toUpperCase(), to: q.get("to") ?? "", amount,
    memo: (q.get("memo") ?? "").slice(0, 140), requestId: (q.get("requestId") ?? generateSiweNonce()).slice(0, 64),
  };
}

export function siweMessage(req: ConnectRequest, mode: NetworkMode, address: Address, now = new Date()): string {
  const chain = CHAINS[mode][req.chain === "solana" ? "base" : req.chain];
  return createSiweMessage({
    domain: new URL(req.product.origin).host,
    uri: req.product.origin,
    address,
    chainId: chain.chainId,
    nonce: req.nonce,
    statement: req.statement,
    version: "1",
    issuedAt: now,
    expirationTime: new Date(now.getTime() + 10 * 60_000),
  });
}

export function reply(origin: string, payload: Record<string, unknown>): boolean {
  const target = window.opener as Window | null;
  if (!target) return false;
  target.postMessage({ source: "firm-wallet", ...payload }, origin);
  return true;
}

export interface Connection {
  productId: string;
  name: string;
  origin: string;
  address: string;
  connectedAt: string;
}
