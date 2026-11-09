/**
 * @conjure: how people reach Conjure™ in every Infinitum product.
 *
 * Anyone types "@conjure <question>" in a message, note, comment or record. The product's
 * server passes the text to `handleConjureMention`; the hosted Conjure service runs a live
 * prediction (this package's swarm engine) and returns a forecast the product posts back.
 *
 * Products call the hosted service, not the engine directly, so every forecast is metered
 * per product and visible to Infinitum staff on the Conjure dashboard. The product key
 * (CONJURE_PRODUCT_KEY) is a server secret: never send it to a browser.
 *
 * Same contract as InfinitumCorp/Conjure client/conjure.mjs (the copy standalone products use).
 */
import type { Report } from "./conjure.ts";

export interface ConjureMention {
  /** The question to forecast; empty when someone typed a bare "@conjure". */
  question: string;
  /** Text before the mention when a question follows it ("Notes… @conjure will X?"). */
  context: string;
}

export interface LivePrediction {
  id: string;
  product: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  question: string;
  round: number;
  rounds: number;
  agents: number;
  poles?: { for: string; against: string };
  stats: { round: number; meanStance: number; split: { for: number; against: number; undecided: number } }[];
  report?: Omit<Report, "steps">;
  error?: string;
  mode?: "live" | "mock";
  createdAt: string;
  finishedAt?: string;
}

export interface PredictOptions {
  context?: string;
  /** Opaque id of the person who asked (for the staff dashboard; no personal data needed). */
  user?: string;
  /** Where in the product it came from: "deal", "thread", "note"… */
  source?: string;
  agents?: number;
  rounds?: number;
  signal?: AbortSignal;
}

export class ConjureApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ConjureApiError";
    this.status = status;
    this.body = body;
  }
}

// "@conjure" as a word: not part of an email (a@conjure.com) or a longer handle (@conjured).
const MENTION = /(^|[^\w@./])@conjure(?![\w-]|\.[a-z])/i;

export function parseConjureMention(text: unknown): ConjureMention | null {
  if (typeof text !== "string") return null;
  const m = MENTION.exec(text);
  if (!m) return null;
  const at = m.index + m[1].length;
  const after = text.slice(at + "@conjure".length).replace(/^[\s:,\-–—]+/, "").trim();
  const before = text.slice(0, at).trim();
  const question = (after || before).replace(/\s+/g, " ").slice(0, 500);
  if (!question) return { question: "", context: "" };
  return { question, context: after && before ? before.slice(0, 30000) : "" };
}

export const hasConjureMention = (text: unknown) => parseConjureMention(text) !== null;

/** Plain-text reply for a thread, chat or record. */
export function formatForecast(p: Partial<LivePrediction> | null | undefined): string {
  const r = p?.report;
  if (!r) {
    if (p?.status === "failed") return `Conjure™ couldn't finish this forecast: ${p.error || "unknown error"}.`;
    return `Conjure™ is forecasting "${p?.question ?? ""}" (round ${p?.round ?? 0} of ${p?.rounds ?? "?"}).`;
  }
  const lines = [
    `Conjure™ forecast: ${r.outcome}`,
    `${Math.round(r.probability * 100)}% likely that ${p?.poles?.for || "it happens"} (${r.confidence} confidence, ${p?.agents} agents over ${p?.rounds} rounds).`,
  ];
  if (r.drivers?.length) lines.push(`Drivers: ${r.drivers.slice(0, 3).join("; ")}.`);
  if (r.signals?.length) lines.push(`Watch: ${r.signals.slice(0, 3).join("; ")}.`);
  lines.push("A simulation is evidence, not proof.");
  return lines.join("\n");
}

export interface ConjureLiveClient {
  health(signal?: AbortSignal): Promise<{ ok: boolean; product: string; live: boolean }>;
  start(question: string, o?: PredictOptions): Promise<LivePrediction>;
  get(id: string, signal?: AbortSignal): Promise<LivePrediction>;
  wait(id: string, o?: { onProgress?: (p: LivePrediction) => void; signal?: AbortSignal; timeoutMs?: number }): Promise<LivePrediction>;
  predict(question: string, o?: PredictOptions & { onProgress?: (p: LivePrediction) => void; timeoutMs?: number }): Promise<LivePrediction>;
  interview(id: string, agentId: string, question: string): Promise<{ answer: string }>;
  cancel(id: string): Promise<{ cancelled: boolean }>;
}

export function createConjureLive(o: { url: string; key: string; fetchImpl?: typeof fetch; pollMs?: number; timeoutMs?: number }): ConjureLiveClient {
  if (!o.url) throw new Error("Conjure: url is required (CONJURE_URL)");
  if (!o.key) throw new Error("Conjure: key is required (CONJURE_PRODUCT_KEY)");
  const base = o.url.replace(/\/+$/, "");
  const f = o.fetchImpl ?? fetch;
  const pollMs = o.pollMs ?? 1500;

  const call = async <T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${o.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new ConjureApiError(data?.error || `Conjure API ${res.status}`, res.status, data);
    return data as T;
  };
  const id = (x: string) => encodeURIComponent(x);

  const client: ConjureLiveClient = {
    health: (signal) => call("GET", "/v1/health", undefined, signal),
    start: (question, p = {}) => call("POST", "/v1/predictions", { question, context: p.context, user: p.user, source: p.source, agents: p.agents, rounds: p.rounds }, p.signal),
    get: (pid, signal) => call("GET", `/v1/predictions/${id(pid)}`, undefined, signal),
    async wait(pid, w = {}) {
      const until = Date.now() + (w.timeoutMs ?? o.timeoutMs ?? 300_000);
      let last = "";
      for (;;) {
        const p = await client.get(pid, w.signal);
        if (`${p.status}:${p.round}` !== last) { last = `${p.status}:${p.round}`; w.onProgress?.(p); }
        if (p.status === "done" || p.status === "failed" || p.status === "cancelled") return p;
        if (Date.now() > until) throw new ConjureApiError("Timed out waiting for the forecast", 504, p);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    async predict(question, p = {}) {
      const started = await client.start(question, p);
      return client.wait(started.id, p);
    },
    interview: (pid, agentId, question) => call("POST", `/v1/predictions/${id(pid)}/interview`, { agentId, question }),
    cancel: (pid) => call("POST", `/v1/predictions/${id(pid)}/cancel`, {}),
  };
  return client;
}

/** A client from CONJURE_URL and CONJURE_PRODUCT_KEY, or null when Conjure isn't configured. */
export function conjureLiveFromEnv(env: Record<string, string | undefined> = process.env): ConjureLiveClient | null {
  return env.CONJURE_URL && env.CONJURE_PRODUCT_KEY ? createConjureLive({ url: env.CONJURE_URL, key: env.CONJURE_PRODUCT_KEY }) : null;
}

/**
 * The one call products make. Returns null when the text has no @conjure. With wait: false
 * (best for request/response handlers) it returns as soon as the forecast starts; poll
 * `client.get(prediction.id)` or show progress from there.
 */
export async function handleConjureMention(
  client: ConjureLiveClient,
  text: string,
  o: PredictOptions & { wait?: boolean; onProgress?: (p: LivePrediction) => void } = {},
): Promise<{ prediction: LivePrediction | null; text: string } | null> {
  const m = parseConjureMention(text);
  if (!m) return null;
  if (!m.question) return { prediction: null, text: "Ask Conjure™ a question after @conjure, for example: @conjure will the Acme deal close this quarter?" };
  const context = [m.context, o.context].filter(Boolean).join("\n\n").slice(0, 30000);
  const opts = { ...o, context };
  const prediction = o.wait === false ? await client.start(m.question, opts) : await client.predict(m.question, opts);
  return { prediction, text: formatForecast(prediction) };
}
