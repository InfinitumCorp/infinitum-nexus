// © Infinitum Corporation®. All rights reserved.
/**
 * Collection SDK for product backends. Batches events, signs each request, and retries
 * transient failures with backoff. Every event gets its id when it is tracked, so a retry
 * resends the same ids and the gateway stores each event once.
 *
 * Runs server-side only: it holds the product credential's secret.
 */
import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION, type ClientEvent, type Payload, type Purpose } from "./envelope.ts";
import { signedHeaders } from "./signing.ts";

export type Transport = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface CollectorOptions {
  endpoint: string;
  keyId: string;
  secret: string;
  product: string;
  batchSize?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
}

export interface TrackInput {
  event_type: string;
  tenant_id: string;
  purpose: Purpose;
  payload?: Payload;
  subject_cid?: string;
  object_id?: string;
  event_id?: string;
  occurred_at?: string;
}

export interface FlushResult {
  sent: number;
  accepted: string[];
  duplicates: string[];
  rejected: { event_id: string | null; status: number; reason: string }[];
  /** Events kept in the queue because the gateway could not be reached. */
  pending: number;
}

const defaultTransport: Transport = async (url, init) => {
  const r = await fetch(url, init);
  return { status: r.status, json: () => r.json() };
};

export class Collector {
  private readonly o: Required<Omit<CollectorOptions, "transport" | "sleep">> & { transport: Transport; sleep: (ms: number) => Promise<void> };
  private queue: ClientEvent[] = [];

  constructor(options: CollectorOptions) {
    if (!/^https:\/\//.test(options.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(options.endpoint)) {
      throw new Error("endpoint must use https");
    }
    this.o = {
      batchSize: 100,
      maxRetries: 5,
      baseDelayMs: 200,
      transport: defaultTransport,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
  }

  /** Queues one event and returns its id. */
  track(input: TrackInput): string {
    const ev: ClientEvent = {
      event_id: input.event_id ?? `evt_${randomUUID().replace(/-/g, "")}`,
      schema_version: SCHEMA_VERSION,
      product: this.o.product,
      event_type: input.event_type,
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      tenant_id: input.tenant_id,
      purpose: input.purpose,
      payload: input.payload ?? {},
      ...(input.subject_cid ? { subject_cid: input.subject_cid } : {}),
      ...(input.object_id ? { object_id: input.object_id } : {}),
    };
    this.queue.push(ev);
    return ev.event_id;
  }

  get pending(): number {
    return this.queue.length;
  }

  async flush(): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, accepted: [], duplicates: [], rejected: [], pending: 0 };
    while (this.queue.length) {
      const batch = this.queue.slice(0, this.o.batchSize);
      const res = await this.send(batch);
      if (!res) break; // keep the batch for the next flush
      this.queue.splice(0, batch.length);
      out.sent += batch.length;
      out.accepted.push(...res.accepted);
      out.duplicates.push(...res.duplicates);
      out.rejected.push(...res.rejected);
    }
    out.pending = this.queue.length;
    return out;
  }

  private async send(batch: ClientEvent[]): Promise<{ accepted: string[]; duplicates: string[]; rejected: FlushResult["rejected"] } | null> {
    const body = JSON.stringify({ events: batch });
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      if (attempt > 0) await this.o.sleep(this.o.baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random()));
      let status: number;
      let json: unknown;
      try {
        const r = await this.o.transport(this.o.endpoint, { method: "POST", headers: signedHeaders(this.o.keyId, this.o.secret, body), body });
        status = r.status;
        json = await r.json().catch(() => ({}));
      } catch {
        continue;
      }
      if (status === 429 || status >= 500) continue;
      const j = (json ?? {}) as { accepted?: string[]; duplicates?: string[]; rejected?: FlushResult["rejected"]; error?: string };
      if (status === 200 || status === 207 || ((status === 403 || status === 422) && j.rejected)) {
        return { accepted: j.accepted ?? [], duplicates: j.duplicates ?? [], rejected: j.rejected ?? [] };
      }
      // 400/401/409/413: the request itself is wrong; retrying will not help.
      return { accepted: [], duplicates: [], rejected: batch.map((e) => ({ event_id: e.event_id, status, reason: j.error ?? `HTTP ${status}` })) };
    }
    return null;
  }
}
