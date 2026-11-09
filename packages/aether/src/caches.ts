/**
 * Bounded caches the node needs: seen message ids, the store-and-forward buffer, and per-source rate limits.
 */
import type { Packet } from "./packet.ts";

/**
 * Message ids seen recently, with the most hops-left (ttl) seen for each.
 * Oldest entries are evicted first when full.
 */
export class SeenCache {
  readonly #entries = new Map<string, { expires: number; ttl: number }>();
  readonly #ttlMs: number;
  readonly #max: number;

  constructor(ttlMs: number, max: number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /** Best ttl seen for this id, or undefined if not seen (or expired). */
  get(id: string, now: number): number | undefined {
    const e = this.#entries.get(id);
    if (!e) return undefined;
    if (e.expires <= now) {
      this.#entries.delete(id);
      return undefined;
    }
    return e.ttl;
  }

  has(id: string, now: number): boolean {
    return this.get(id, now) !== undefined;
  }

  add(id: string, now: number, ttl: number) {
    const prev = this.#entries.get(id);
    this.#entries.delete(id);
    this.#entries.set(id, { expires: prev && prev.expires > now ? prev.expires : now + this.#ttlMs, ttl });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size() {
    return this.#entries.size;
  }
}

interface Stored {
  packet: Packet;
  expires: number;
}

/** Packets held for peers that show up later. */
export class PacketStore {
  readonly #items = new Map<string, Stored>();
  readonly #windowMs: number;
  readonly #max: number;

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs;
    this.#max = max;
  }

  put(id: string, packet: Packet, now: number) {
    // Expire by the sender's timestamp so a packet cannot live longer by being relayed.
    const expires = Math.min(packet.timestamp, now) + this.#windowMs;
    if (expires <= now) return;
    this.#items.delete(id);
    this.#items.set(id, { packet, expires });
    while (this.#items.size > this.#max) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }

  delete(id: string) {
    this.#items.delete(id);
  }

  has(id: string) {
    return this.#items.has(id);
  }

  /** Live packets, oldest first. Expired ones are dropped as a side effect. */
  live(now: number): Packet[] {
    const out: Packet[] = [];
    for (const [id, item] of this.#items) {
      if (item.expires <= now) this.#items.delete(id);
      else out.push(item.packet);
    }
    return out;
  }

  get size() {
    return this.#items.size;
  }
}

/** Token bucket per key. */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #perMinute: number;
  readonly #burst: number;
  readonly #maxKeys: number;

  constructor(perMinute: number, burst: number, maxKeys = 4096) {
    this.#perMinute = perMinute;
    this.#burst = burst;
    this.#maxKeys = maxKeys;
  }

  allow(key: string, now: number): boolean {
    let b = this.#buckets.get(key);
    if (!b) {
      b = { tokens: this.#burst, at: now };
      if (this.#buckets.size >= this.#maxKeys) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
    } else {
      this.#buckets.delete(key);
      b.tokens = Math.min(this.#burst, b.tokens + ((now - b.at) / 60_000) * this.#perMinute);
      b.at = now;
    }
    this.#buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
