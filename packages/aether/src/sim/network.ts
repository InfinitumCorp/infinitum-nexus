/**
 * Deterministic discrete-event radio network for testing ÆTHER nodes.
 * Nodes sit at fixed points; two nodes are linked when both are online and within range.
 */
import type { Transport } from "../transport.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Event {
  at: number;
  seq: number;
  run: () => void;
}

class EventQueue {
  readonly #heap: Event[] = [];
  #seq = 0;

  push(at: number, run: () => void) {
    const h = this.#heap;
    h.push({ at, seq: this.#seq++, run });
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(h[p]!, h[i]!)) break;
      [h[p], h[i]] = [h[i]!, h[p]!];
      i = p;
    }
  }

  peek(): Event | undefined {
    return this.#heap[0];
  }

  pop(): Event | undefined {
    const h = this.#heap;
    const top = h[0];
    const last = h.pop();
    if (h.length && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && less(h[l]!, h[m]!)) m = l;
        if (r < h.length && less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i]!, h[m]!];
        i = m;
      }
    }
    return top;
  }

  get size() {
    return this.#heap.length;
  }
}

function less(a: Event, b: Event) {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

export interface SimNetworkOptions {
  range: number;
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Chance a single transmission is lost. */
  lossRate?: number;
  seed?: number;
  startTime?: number;
}

export class SimNetwork {
  time: number;
  frames = 0;
  readonly #queue = new EventQueue();
  readonly #nodes: SimTransport[] = [];
  readonly #rand: () => number;
  readonly #opts: Required<Omit<SimNetworkOptions, "seed" | "startTime">>;

  constructor(opts: SimNetworkOptions) {
    this.time = opts.startTime ?? 1_800_000_000_000;
    this.#rand = mulberry32(opts.seed ?? 1);
    this.#opts = { minLatencyMs: 20, maxLatencyMs: 120, lossRate: 0, ...opts };
  }

  /** Whole milliseconds, like Date.now(). */
  now = () => Math.floor(this.time);

  random(): number {
    return this.#rand();
  }

  add(x: number, y: number): SimTransport {
    const t = new SimTransport(this, this.#nodes.length, x, y);
    this.#nodes.push(t);
    return t;
  }

  get transports(): readonly SimTransport[] {
    return this.#nodes;
  }

  inRange(a: SimTransport, b: SimTransport): boolean {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy <= this.#opts.range * this.#opts.range;
  }

  linked(a: SimTransport, b: SimTransport): boolean {
    return a !== b && a.online && b.online && this.inRange(a, b);
  }

  /** Neighbours in range, ignoring online state. */
  neighbours(t: SimTransport): SimTransport[] {
    return this.#nodes.filter((o) => o !== t && this.inRange(o, t));
  }

  setOnline(t: SimTransport, online: boolean) {
    if (t.online === online) return;
    const before = this.neighbours(t).filter((o) => this.linked(t, o));
    t.online = online;
    if (online) {
      for (const o of this.neighbours(t)) {
        if (this.linked(t, o)) {
          this.schedule(0, () => {
            if (this.linked(t, o)) {
              t.emitPeerUp(String(o.index));
              o.emitPeerUp(String(t.index));
            }
          });
        }
      }
    } else {
      for (const o of before) {
        t.emitPeerDown(String(o.index));
        o.emitPeerDown(String(t.index));
      }
    }
  }

  schedule(delayMs: number, run: () => void) {
    this.#queue.push(this.time + delayMs, run);
  }

  transmit(from: SimTransport, toIndex: number, data: Uint8Array) {
    const to = this.#nodes[toIndex];
    if (!to || !this.linked(from, to)) return;
    this.frames++;
    if (this.#rand() < this.#opts.lossRate) return;
    const { minLatencyMs, maxLatencyMs } = this.#opts;
    const latency = minLatencyMs + this.#rand() * (maxLatencyMs - minLatencyMs);
    this.schedule(latency, () => {
      if (this.linked(from, to)) to.emitReceive(String(from.index), data);
    });
  }

  /** Run events until the clock passes `until` (absolute ms). */
  runUntil(until: number) {
    for (;;) {
      const next = this.#queue.peek();
      if (!next || next.at > until) break;
      this.#queue.pop();
      this.time = next.at;
      next.run();
    }
    this.time = until;
  }
}

export class SimTransport implements Transport {
  online = true;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly #net: SimNetwork;
  readonly #recv: ((peer: string, data: Uint8Array) => void)[] = [];
  readonly #up: ((peer: string) => void)[] = [];
  readonly #down: ((peer: string) => void)[] = [];

  constructor(net: SimNetwork, index: number, x: number, y: number) {
    this.#net = net;
    this.index = index;
    this.x = x;
    this.y = y;
  }

  peers(): string[] {
    if (!this.online) return [];
    return this.#net
      .neighbours(this)
      .filter((o) => this.#net.linked(this, o))
      .map((o) => String(o.index));
  }

  send(peer: string, data: Uint8Array) {
    if (this.online) this.#net.transmit(this, Number(peer), data);
  }

  onReceive(h: (peer: string, data: Uint8Array) => void) {
    this.#recv.push(h);
  }
  onPeerUp(h: (peer: string) => void) {
    this.#up.push(h);
  }
  onPeerDown(h: (peer: string) => void) {
    this.#down.push(h);
  }

  emitReceive(peer: string, data: Uint8Array) {
    for (const h of this.#recv) h(peer, data);
  }
  emitPeerUp(peer: string) {
    for (const h of this.#up) h(peer);
  }
  emitPeerDown(peer: string) {
    for (const h of this.#down) h(peer);
  }
}
