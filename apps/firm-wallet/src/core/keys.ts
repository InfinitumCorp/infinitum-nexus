/**
 * Key derivation. Keys are made and kept on the device; nothing here touches the network.
 *
 * - Recovery phrase: BIP-39, 12 or 24 English words (@scure/bip39).
 * - Ethereum and Base: BIP-44 m/44'/60'/0'/0/i, secp256k1 (viem, which uses @scure/bip32).
 * - Solana: m/44'/501'/i'/0' with SLIP-0010 ed25519 (the Phantom / Solflare path).
 */
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { mnemonicToAccount, type HDAccount } from "viem/accounts";

export function newRecoveryPhrase(words: 12 | 24 = 12): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidPhrase(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

export function evmAccount(phrase: string, index = 0): HDAccount {
  return mnemonicToAccount(normalizePhrase(phrase), { addressIndex: index });
}

const HARDENED = 0x80000000;

/** SLIP-0010 ed25519 derivation (hardened steps only, as the spec requires). */
export function slip10Ed25519(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const index of path) {
    const i = (index | HARDENED) >>> 0;
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, i, false);
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

export interface SolanaKeypair {
  address: string;
  publicKey: Uint8Array;
  /** 32-byte ed25519 secret seed. Keep in memory only while unlocked. */
  secret: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function solanaKeypair(phrase: string, index = 0): SolanaKeypair {
  const seed = mnemonicToSeedSync(normalizePhrase(phrase));
  const secret = slip10Ed25519(seed, [44, 501, index, 0]);
  const publicKey = ed25519.getPublicKey(secret);
  return {
    address: base58.encode(publicKey),
    publicKey,
    secret,
    sign: (message) => ed25519.sign(message, secret),
  };
}

export function isSolanaAddress(a: string): boolean {
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}
