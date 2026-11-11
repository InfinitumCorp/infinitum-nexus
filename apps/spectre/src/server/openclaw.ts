/**
 * OpenClaw in +SPCTR: "@openclaw <task>" in Ask hands the task to an OpenClaw agent.
 *
 * OpenClaw (https://openclaw.ai) is a self-hosted agent gateway. +SPCTR talks to its
 * OpenAI-compatible endpoint, POST /v1/chat/completions, which the gateway turns on with
 * gateway.http.endpoints.chatCompletions.enabled = true. The `model` field picks the agent
 * ("openclaw" is the gateway's default agent, "openclaw/<agentId>" a specific one).
 *
 * The gateway token carries full operator authority over that gateway, so it is a server
 * secret (OPENCLAW_GATEWAY_TOKEN): it never reaches a browser and never appears in errors.
 * +SPCTR sends text only (no tools), so the agent cannot act inside +SPCTR; it answers from
 * the workspace summary it is given plus whatever its own OpenClaw skills can do.
 */

export interface OpenClawConfig {
  /** Gateway base URL, for example https://claw.example.ts.net. https unless it is localhost. */
  url: string;
  /** Gateway bearer token (gateway.auth.token) or password. */
  token: string;
  /** Agent to use: "openclaw" (default agent) or "openclaw/<agentId>". */
  agent?: string;
  /** Milliseconds to wait for the agent. Agents can run tools, so this is generous. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenClawClient {
  readonly agent: string;
  /** Send one task; `user` keeps one OpenClaw session per person (the gateway derives it). */
  ask(task: string, opts: { user: string; context?: string; signal?: AbortSignal }): Promise<string>;
}

export class OpenClawError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenClawError";
    this.status = status;
  }
}

const MAX_ANSWER = 20_000;
const MENTION = /(^|\s)@openclaw\b/i;

/** The task after "@openclaw", or null when the text doesn't mention OpenClaw. */
export function parseOpenClawMention(text: string): { task: string } | null {
  const m = MENTION.exec(text);
  if (!m) return null;
  const task = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { task };
}

function checkUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("OPENCLAW_GATEWAY_URL is not a valid URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("OPENCLAW_GATEWAY_URL must use https");
  if (u.username || u.password) throw new Error("Put the gateway token in OPENCLAW_GATEWAY_TOKEN, not in the URL");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function checkAgent(agent: string): string {
  if (!/^(openclaw([/:][A-Za-z0-9_-]{1,64})?|agent:[A-Za-z0-9_-]{1,64})$/.test(agent)) throw new Error(`OPENCLAW_AGENT "${agent}" is not an OpenClaw agent name`);
  return agent;
}

export function createOpenClaw(config: OpenClawConfig): OpenClawClient {
  const base = checkUrl(config.url);
  const agent = checkAgent(config.agent || "openclaw");
  const timeoutMs = config.timeoutMs ?? 120_000;
  const doFetch = config.fetchImpl ?? fetch;
  const token = config.token;
  if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is not set");

  return {
    agent,
    async ask(task, opts) {
      const messages = [
        ...(opts.context ? [{ role: "system", content: opts.context }] : []),
        { role: "user", content: task },
      ];
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        // Called as a plain function: Workers throw "Illegal invocation" for fetch bound to another object.
        res = await doFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: agent, messages, user: opts.user, stream: false }),
          signal,
        });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") throw new OpenClawError("OpenClaw took too long to answer.", 504);
        throw new OpenClawError("Couldn't reach the OpenClaw gateway.", 502);
      }
      if (res.status === 401 || res.status === 403) throw new OpenClawError("The OpenClaw gateway refused +SPCTR's token.", 502);
      if (res.status === 404) throw new OpenClawError("The OpenClaw gateway's chat endpoint is off. Enable gateway.http.endpoints.chatCompletions.", 502);
      if (res.status === 429) throw new OpenClawError("OpenClaw is busy. Try again in a moment.", 429);
      if (!res.ok) throw new OpenClawError(`OpenClaw returned ${res.status}.`, 502);
      const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
      const content = body?.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("")
        : "";
      if (!text.trim()) throw new OpenClawError("OpenClaw sent an empty answer.", 502);
      return text.slice(0, MAX_ANSWER);
    },
  };
}

/** From OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and optional OPENCLAW_AGENT; null when not set. */
export function openClawFromEnv(env: Record<string, string | undefined> = process.env): OpenClawClient | null {
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) return null;
  return createOpenClaw({ url: env.OPENCLAW_GATEWAY_URL, token: env.OPENCLAW_GATEWAY_TOKEN, agent: env.OPENCLAW_AGENT });
}
