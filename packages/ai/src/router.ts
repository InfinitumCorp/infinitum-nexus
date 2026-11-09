/**
 * The Infinitum model router.
 *
 * One chat() call; the router picks the model and host. Switching is
 * automatic and instant, so products and their users never pick a model:
 *
 * - Failover: an error, timeout, rate limit, malformed tool call or empty
 *   reply moves the request straight to the next candidate.
 * - Hedging: if the current candidate hasn't answered within `hedgeMs`, the
 *   next one starts in parallel and the first good answer wins; the loser is
 *   cancelled.
 * - Health: failing candidates cool down (rate limits honor Retry-After, bad
 *   keys park the whole host) and recover on their own, so later requests
 *   skip a broken host without waiting on it.
 *
 * Messages are kept in one neutral format, so a tool-using agent can start
 * on one model and finish on another.
 */
import { MODELS, type Tier } from "./catalog.ts";

export interface Provider {
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Canonical model id -> host model name. */
  models: Record<string, string>;
  /**
   * For gateways that route on their own (OmniRoute combos): the host model
   * to use for a tier, tried before any per-model candidate.
   */
  tierModels?: Partial<Record<Tier, string>>;
  headers?: Record<string, string>;
  /** Transport for this host only (e.g. the Workers AI binding); defaults to the router's fetch. */
  fetch?: typeof fetch;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  /** "smart" (default) for reasoning and agents, "fast" for short summaries and drafts. */
  tier?: Tier;
  /** Restrict to these canonical model ids, in preference order. */
  models?: string[];
  signal?: AbortSignal;
}

export interface Attempt {
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  status?: number;
  error?: string;
  /** Cancelled because another candidate answered first. */
  cancelled?: boolean;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length";
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
  attempts: Attempt[];
}

export class AiError extends Error {
  readonly attempts: Attempt[];
  readonly status?: number;
  constructor(message: string, attempts: Attempt[] = [], status?: number) {
    super(message);
    this.attempts = attempts;
    this.status = status;
  }
}

export class AiNotConfigured extends AiError {
  constructor() {
    super("AI isn't connected yet. Set OMNIROUTE_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY, DEEPINFRA_API_KEY, OPENROUTER_API_KEY, CLOUDFLARE_ACCOUNT_ID with CLOUDFLARE_AI_TOKEN, OLLAMA_BASE_URL or AI_BASE_URL on the server.", [], 503);
  }
}

export interface RouterOptions {
  providers: Provider[];
  fetchImpl?: typeof fetch;
  /** Per-attempt limit. Default 45 s. */
  timeoutMs?: number;
  /** Start the next candidate in parallel after this long. 0 disables. Default 5 s. */
  hedgeMs?: number;
  /** Base cool-down after a failure. Default 30 s. */
  cooldownMs?: number;
  now?: () => number;
}

export interface CandidateStatus {
  provider: string;
  model: string;
  hostModel: string;
  healthy: boolean;
  coolingUntil?: number;
  failures: number;
  avgMs?: number;
}

export interface AiRouter {
  readonly connected: boolean;
  readonly providers: readonly string[];
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Text-only convenience: one system prompt, one user message. */
  complete(system: string, user: string, opts?: { maxTokens?: number; tier?: Tier; temperature?: number }): Promise<string>;
  candidates(req?: Pick<ChatRequest, "tier" | "tools" | "models">): { provider: Provider; model: string; hostModel: string }[];
  status(): CandidateStatus[];
}

interface Health {
  failures: number;
  until: number;
  avgMs?: number;
}

class AttemptError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly scope: "candidate" | "provider";
  constructor(message: string, opts: { status?: number; retryAfterMs?: number; scope?: "candidate" | "provider" } = {}) {
    super(message);
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.scope = opts.scope ?? "candidate";
  }
}

const THINK = /<think>[\s\S]*?<\/think>/g;

function tierOrder(tier: Tier): string[] {
  const own = MODELS.filter((m) => m.tier === tier).map((m) => m.id);
  const other = MODELS.filter((m) => m.tier !== tier).map((m) => m.id);
  return [...own, ...other];
}

export function createRouter(opts: RouterOptions): AiRouter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const hedgeMs = opts.hedgeMs ?? 5_000;
  const cooldownMs = opts.cooldownMs ?? 30_000;
  const now = opts.now ?? Date.now;
  const providers = opts.providers;
  const health = new Map<string, Health>();
  const providerHealth = new Map<string, Health>();
  const toolCapable = new Set(MODELS.filter((m) => m.tools).map((m) => m.id));

  const key = (p: string, m: string) => `${p}/${m}`;
  const coolingCandidate = (p: string, m: string) => (health.get(key(p, m))?.until ?? 0) > now();
  const coolingProvider = (p: string) => (providerHealth.get(p)?.until ?? 0) > now();

  function candidates(req: Pick<ChatRequest, "tier" | "tools" | "models"> = {}) {
    const known = new Set(MODELS.map((m) => m.id));
    let order = req.models?.length ? req.models : tierOrder(req.tier ?? "smart");
    // Custom canonical ids (e.g. from a self-hosted AI_MODELS map) are tried after the catalog.
    if (!req.models?.length) {
      const extra = [...new Set(providers.flatMap((p) => Object.keys(p.models)))].filter((m) => !known.has(m));
      order = [...extra, ...order];
    }
    if (req.tools?.length) order = order.filter((m) => toolCapable.has(m) || !known.has(m));
    const list: { provider: Provider; model: string; hostModel: string }[] = [];
    if (!req.models?.length) {
      const tier = req.tier ?? "smart";
      for (const provider of providers) {
        const hostModel = provider.tierModels?.[tier];
        if (hostModel) list.push({ provider, model: `${provider.name}:${tier}`, hostModel });
      }
    }
    for (const model of order) {
      for (const provider of providers) {
        const hostModel = provider.models[model];
        if (hostModel) list.push({ provider, model, hostModel });
      }
    }
    // Healthy first; cooling candidates stay at the back as a last resort.
    const healthy = list.filter((c) => !coolingProvider(c.provider.name) && !coolingCandidate(c.provider.name, c.model));
    const cooling = list.filter((c) => !healthy.includes(c));
    return [...healthy, ...cooling];
  }

  function recordSuccess(p: string, m: string, ms: number) {
    const h = health.get(key(p, m));
    health.set(key(p, m), { failures: 0, until: 0, avgMs: h?.avgMs === undefined ? ms : h.avgMs * 0.7 + ms * 0.3 });
    providerHealth.delete(p);
  }

  function recordFailure(p: string, m: string, err: AttemptError) {
    if (err.scope === "provider") {
      const h = providerHealth.get(p) ?? { failures: 0, until: 0 };
      h.failures++;
      h.until = now() + (err.retryAfterMs ?? (err.status === 401 || err.status === 403 ? 10 * 60_000 : cooldownMs));
      providerHealth.set(p, h);
      return;
    }
    const h = health.get(key(p, m)) ?? { failures: 0, until: 0 };
    h.failures++;
    const backoff = err.status === 404 ? 10 * 60_000 : cooldownMs * Math.min(8, 2 ** (h.failures - 1));
    h.until = now() + (err.retryAfterMs ?? backoff);
    health.set(key(p, m), h);
  }

  async function callOne(c: { provider: Provider; model: string; hostModel: string }, req: ChatRequest, signal: AbortSignal) {
    const messages: unknown[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      if (m.role === "tool") messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      else if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
        });
      } else messages.push({ role: m.role, content: m.content });
    }
    const body: Record<string, unknown> = { model: c.hostModel, messages, max_tokens: req.maxTokens ?? 2000, stream: false };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    let res: Response;
    try {
      res = await (c.provider.fetch ?? fetchImpl)(`${c.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(c.provider.apiKey ? { authorization: `Bearer ${c.provider.apiKey}` } : {}),
          ...c.provider.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new AttemptError(signal.aborted ? "timed out" : `network: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      const retryAfter = Number(res.headers.get("retry-after"));
      const scope = res.status === 401 || res.status === 403 || res.status === 429 ? "provider" : "candidate";
      throw new AttemptError(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`, {
        status: res.status,
        scope,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) * 1000 : undefined,
      });
    }
    const payload = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const choice = payload?.choices?.[0];
    if (!choice?.message) throw new AttemptError("no reply");
    const text = (choice.message.content ?? "").replace(THINK, "").trim();
    const toolCalls: ToolCall[] = [];
    for (const [i, t] of (choice.message.tool_calls ?? []).entries()) {
      if (!t.function?.name) throw new AttemptError("malformed tool call");
      let args: unknown = {};
      try {
        args = t.function.arguments ? JSON.parse(t.function.arguments) : {};
      } catch {
        throw new AttemptError(`malformed tool arguments for ${t.function.name}`);
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new AttemptError(`tool arguments for ${t.function.name} aren't an object`);
      toolCalls.push({ id: t.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`, name: t.function.name, arguments: args as Record<string, unknown> });
    }
    if (!text && toolCalls.length === 0) throw new AttemptError("empty reply");
    const finishReason: ChatResult["finishReason"] = toolCalls.length ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop";
    return {
      text,
      toolCalls,
      finishReason,
      usage: { inputTokens: payload?.usage?.prompt_tokens ?? 0, outputTokens: payload?.usage?.completion_tokens ?? 0 },
    };
  }

  function chat(req: ChatRequest): Promise<ChatResult> {
    const list = candidates(req);
    if (list.length === 0) return Promise.reject(providers.length ? new AiError("No configured host serves the requested models.", [], 503) : new AiNotConfigured());
    const attempts: Attempt[] = [];

    return new Promise<ChatResult>((resolve, reject) => {
      let next = 0;
      let inflight = 0;
      let settled = false;
      let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
      const running = new Set<AbortController>();

      const finish = () => {
        settled = true;
        clearTimeout(hedgeTimer);
        req.signal?.removeEventListener("abort", onAbort);
        for (const ac of running) ac.abort();
      };
      const onAbort = () => {
        if (settled) return;
        finish();
        reject(new AiError("Request cancelled", attempts));
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });

      const launch = () => {
        if (settled) return;
        clearTimeout(hedgeTimer);
        if (next >= list.length) {
          if (inflight === 0) {
            finish();
            const last = attempts.filter((a) => !a.ok && !a.cancelled).at(-1);
            reject(new AiError(`Every model failed (${attempts.length} attempts). Last: ${last ? `${last.provider}/${last.model}: ${last.error}` : "none"}`, attempts, 502));
          }
          return;
        }
        const c = list[next++]!;
        const ac = new AbortController();
        running.add(ac);
        inflight++;
        const started = now();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        if (hedgeMs > 0 && next < list.length) hedgeTimer = setTimeout(launch, hedgeMs);

        callOne(c, req, ac.signal).then(
          (r) => {
            clearTimeout(timer);
            running.delete(ac);
            inflight--;
            if (settled) return;
            const ms = now() - started;
            attempts.push({ provider: c.provider.name, model: c.model, ok: true, ms });
            recordSuccess(c.provider.name, c.model, ms);
            finish();
            for (const a of attempts) if (!a.ok && a.error === undefined) a.cancelled = true;
            resolve({ ...r, provider: c.provider.name, model: c.model, attempts });
          },
          (err: AttemptError) => {
            clearTimeout(timer);
            running.delete(ac);
            inflight--;
            const ms = now() - started;
            if (settled) {
              attempts.push({ provider: c.provider.name, model: c.model, ok: false, ms, cancelled: true });
              return;
            }
            attempts.push({ provider: c.provider.name, model: c.model, ok: false, ms, status: err.status, error: err.message });
            recordFailure(c.provider.name, c.model, err);
            launch();
          },
        );
      };
      launch();
    });
  }

  return {
    get connected() {
      return providers.length > 0;
    },
    providers: providers.map((p) => p.name),
    chat,
    async complete(system, user, o) {
      const r = await chat({ system, messages: [{ role: "user", content: user }], maxTokens: o?.maxTokens, tier: o?.tier, temperature: o?.temperature });
      return r.text;
    },
    candidates,
    status() {
      return providers.flatMap((p) =>
        Object.entries(p.models).map(([model, hostModel]) => {
          const h = health.get(key(p.name, model));
          const ph = providerHealth.get(p.name);
          const until = Math.max(h?.until ?? 0, ph?.until ?? 0);
          return {
            provider: p.name,
            model,
            hostModel,
            healthy: until <= now(),
            coolingUntil: until > now() ? until : undefined,
            failures: (h?.failures ?? 0) + (ph?.failures ?? 0),
            avgMs: h?.avgMs,
          };
        }),
      );
    },
  };
}
