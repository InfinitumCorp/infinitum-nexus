/**
 * In-memory browser sessions and one-time OAuth state.
 * API clients send a bearer token and do not use this store.
 */
import { createHash } from "node:crypto";
import type { CndctrIdentity } from "./auth.ts";

interface OauthState {
  verifier: string;
  nonce: string;
  exp: number;
}

interface Session {
  identity: CndctrIdentity;
  exp: number;
}

export class SessionStore {
  private readonly states = new Map<string, OauthState>();
  private readonly sessions = new Map<string, Session>();

  saveState(state: string, verifier: string, nonce: string, exp: number): void {
    this.prune(this.states);
    this.states.set(state, { verifier, nonce, exp });
  }

  takeState(state: string, now = Date.now()): OauthState | null {
    const saved = this.states.get(state);
    this.states.delete(state);
    if (!saved || saved.exp <= now) return null;
    return saved;
  }

  create(token: string, identity: CndctrIdentity, exp: number): void {
    this.prune(this.sessions);
    this.sessions.set(hash(token), { identity, exp });
  }

  read(token: string, now = Date.now()): CndctrIdentity | null {
    const key = hash(token);
    const saved = this.sessions.get(key);
    if (!saved) return null;
    if (saved.exp <= now) {
      this.sessions.delete(key);
      return null;
    }
    return saved.identity;
  }

  delete(token: string): void {
    this.sessions.delete(hash(token));
  }

  private prune<T extends { exp: number }>(map: Map<string, T>): void {
    if (map.size < 5_000) return;
    const now = Date.now();
    for (const [key, value] of map) {
      if (value.exp <= now) map.delete(key);
    }
    if (map.size >= 5_000) map.clear();
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
