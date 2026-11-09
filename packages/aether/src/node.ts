/**
 * ÆTHER mesh node: flooding with TTL and de-duplication, store-and-forward, delivery receipts.
 * Behaviour follows docs/SPEC.md "Node behaviour".
 */
import { toHex, type Identity } from "./identity.ts";
import { PacketStore, RateLimiter, SeenCache } from "./caches.ts";
import {
  BROADCAST,
  MSG_ID_BYTES,
  PacketError,
  PacketType,
  buildPacket,
  decodePacket,
  encodePacket,
  forwarded,
  isBroadcast,
  msgIdHex,
  verifyPacket,
  type Packet,
} from "./packet.ts";
import type { Transport } from "./transport.ts";

export interface NodeOptions {
  /** Clock in ms; injectable for the simulator. */
  now?: () => number;
  defaultTtl?: number;
  storeWindowMs?: number;
  storeMax?: number;
  seenTtlMs?: number;
  seenMax?: number;
  maxFutureSkewMs?: number;
  ratePerMinute?: number;
  rateBurst?: number;
  /** Send a receipt for every message delivered here. */
  receipts?: boolean;
}

export interface Delivered {
  msgId: string;
  /** Sender node id (hex public key). */
  from: string;
  payload: Uint8Array;
  broadcast: boolean;
  hops: number;
  timestamp: number;
}

export type DropReason = "malformed" | "duplicate" | "bad-signature" | "expired" | "future" | "rate-limited";

export interface NodeStats {
  sent: number;
  received: number;
  delivered: number;
  forwarded: number;
  receiptsReceived: number;
  /** Duplicates re-forwarded because they had more hops left. */
  upgrades: number;
  dropped: Record<DropReason, number>;
}

const DEFAULTS = {
  defaultTtl: 16,
  storeWindowMs: 6 * 60 * 60_000,
  storeMax: 512,
  seenTtlMs: 24 * 60 * 60_000,
  seenMax: 8192,
  maxFutureSkewMs: 5 * 60_000,
  ratePerMinute: 120,
  rateBurst: 240,
  receipts: true,
};

export class MeshNode {
  readonly identity: Identity;
  readonly stats: NodeStats = {
    sent: 0,
    received: 0,
    delivered: 0,
    forwarded: 0,
    receiptsReceived: 0,
    upgrades: 0,
    dropped: { malformed: 0, duplicate: 0, "bad-signature": 0, expired: 0, future: 0, "rate-limited": 0 },
  };

  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #opts: typeof DEFAULTS;
  readonly #seen: SeenCache;
  readonly #store: PacketStore;
  readonly #limiter: RateLimiter;
  readonly #outbox = new Set<string>();
  /** Messages known to be delivered (a receipt was seen); never carried again. */
  readonly #acked = new Set<string>();
  readonly #messageHandlers: ((m: Delivered) => void)[] = [];
  readonly #receiptHandlers: ((msgId: string) => void)[] = [];

  constructor(identity: Identity, transport: Transport, options: NodeOptions = {}) {
    this.identity = identity;
    this.#transport = transport;
    this.#now = options.now ?? Date.now;
    this.#opts = { ...DEFAULTS, ...stripUndefined(options) };
    this.#seen = new SeenCache(this.#opts.seenTtlMs, this.#opts.seenMax);
    this.#store = new PacketStore(this.#opts.storeWindowMs, this.#opts.storeMax);
    this.#limiter = new RateLimiter(this.#opts.ratePerMinute, this.#opts.rateBurst);
    transport.onReceive((peer, data) => this.#receive(peer, data));
    transport.onPeerUp((peer) => this.#peerUp(peer));
  }

  get id(): string {
    return this.identity.id;
  }

  onMessage(handler: (m: Delivered) => void) {
    this.#messageHandlers.push(handler);
  }

  onReceipt(handler: (msgId: string) => void) {
    this.#receiptHandlers.push(handler);
  }

  /** Send to one node (32-byte public key). Returns the message id. */
  send(dst: Uint8Array, payload: Uint8Array, ttl = this.#opts.defaultTtl): string {
    return this.#originate(buildPacket(this.identity, dst, payload, { ttl, timestamp: this.#now() }), true);
  }

  /** Send to everyone in reach. Broadcasts get no receipts. */
  broadcast(payload: Uint8Array, ttl = this.#opts.defaultTtl): string {
    return this.#originate(buildPacket(this.identity, BROADCAST, payload, { ttl, timestamp: this.#now() }), false);
  }

  /** Message ids sent by this node with no receipt yet. */
  pending(): string[] {
    return [...this.#outbox];
  }

  get storedCount() {
    return this.#store.size;
  }

  #originate(packet: Packet, awaitReceipt: boolean): string {
    const id = msgIdHex(packet);
    const now = this.#now();
    this.#seen.add(id, now, packet.ttl);
    this.#store.put(id, packet, now);
    if (awaitReceipt) this.#outbox.add(id);
    this.stats.sent++;
    this.#flood(packet);
    return id;
  }

  #receive(peer: string, data: Uint8Array) {
    this.stats.received++;
    const now = this.#now();
    // Peers re-offer stored packets on every reconnect; reject known ids before decoding,
    // unless this copy has more hops left than any copy seen (see "ttl upgrade" below).
    if (data.length >= 24) {
      const best = this.#seen.get(toHex(data.subarray(8, 24)), now);
      if (best !== undefined && data[5]! <= best) return this.#drop("duplicate");
    }
    let packet: Packet;
    try {
      packet = decodePacket(data);
    } catch (e) {
      if (e instanceof PacketError) return this.#drop("malformed");
      throw e;
    }
    const id = msgIdHex(packet);
    const best = this.#seen.get(id, now);
    if (best !== undefined && packet.ttl <= best) return this.#drop("duplicate");
    // Verify before marking seen, so a forged copy cannot shadow the genuine packet.
    if (!verifyPacket(packet)) return this.#drop("bad-signature");
    if (packet.timestamp > now + this.#opts.maxFutureSkewMs) return this.#drop("future");
    if (packet.timestamp < now - this.#opts.storeWindowMs) return this.#drop("expired");
    const src = toHex(packet.src);
    this.#seen.add(id, now, packet.ttl);

    // ttl upgrade: under churn the first copy can arrive by a long detour with few hops left.
    // A later copy with more hops left is forwarded again (never re-delivered).
    if (best !== undefined) {
      this.stats.upgrades++;
      if (packet.ttl > 0 && toHex(packet.dst) !== this.id && !this.#acked.has(id)) {
        const next = forwarded(packet);
        this.#store.put(id, next, now);
        this.stats.forwarded++;
        this.#flood(next, peer);
      }
      return;
    }
    if (!this.#limiter.allow(src, now)) return this.#drop("rate-limited");

    const forMe = toHex(packet.dst) === this.id;
    const broadcast = isBroadcast(packet.dst);

    if (packet.type === PacketType.Receipt) {
      if (packet.payload.length === MSG_ID_BYTES) {
        const acked = toHex(packet.payload);
        // Every node that sees a receipt stops carrying the acknowledged message.
        this.#store.delete(acked);
        this.#acked.add(acked);
        if (this.#acked.size > this.#opts.seenMax) {
          const oldest = this.#acked.values().next().value;
          if (oldest !== undefined) this.#acked.delete(oldest);
        }
        if (forMe && this.#outbox.delete(acked)) {
          this.stats.receiptsReceived++;
          for (const h of this.#receiptHandlers) h(acked);
        }
      }
    } else if (forMe || broadcast) {
      this.stats.delivered++;
      const msg: Delivered = { msgId: id, from: src, payload: packet.payload, broadcast, hops: packet.hops + 1, timestamp: packet.timestamp };
      for (const h of this.#messageHandlers) h(msg);
      if (forMe && this.#opts.receipts) {
        const receipt = buildPacket(this.identity, packet.src, packet.msgId, {
          type: PacketType.Receipt,
          ttl: this.#opts.defaultTtl,
          timestamp: now,
        });
        this.#originate(receipt, false);
      }
    }

    if (!forMe && packet.ttl > 0) {
      const next = forwarded(packet);
      this.#store.put(id, next, now);
      this.stats.forwarded++;
      this.#flood(next, peer);
    }
  }

  #flood(packet: Packet, except?: string) {
    const bytes = encodePacket(packet);
    for (const peer of this.#transport.peers()) {
      if (peer !== except) this.#transport.send(peer, bytes);
    }
  }

  #peerUp(peer: string) {
    for (const packet of this.#store.live(this.#now())) {
      this.#transport.send(peer, encodePacket(packet));
    }
  }

  #drop(reason: DropReason) {
    this.stats.dropped[reason]++;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
