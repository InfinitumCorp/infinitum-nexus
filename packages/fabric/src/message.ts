/**
 * FABRIC message sealed with AES-256-GCM.
 * The string key is a shared secret. {@link encrypt} derives the AES key with scrypt.
 */
import { randomUUID } from "node:crypto";
import { decryptAead, encryptAead } from "./aead.ts";

export interface FabricMessage {
  id: string;
  from: string;
  to: string;
  ciphertext: string;
  createdAt: string;
}

export function encrypt(plaintext: string, key: string): string {
  return encryptAead(plaintext, key);
}

export function decrypt(ciphertext: string, key: string): string {
  return decryptAead(ciphertext, key);
}

export function createMessage(from: string, to: string, plaintext: string, key: string): FabricMessage {
  return {
    id: `fab_${randomUUID()}`,
    from,
    to,
    ciphertext: encrypt(plaintext, key),
    createdAt: new Date().toISOString(),
  };
}
