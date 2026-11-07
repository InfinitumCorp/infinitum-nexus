/**
 * Build the router from environment variables, so every app is configured
 * the same way and no app hard-codes a model.
 *
 * Hosts (any subset; tried in this order unless AI_PROVIDER_ORDER is set):
 *   AI_BASE_URL (+ AI_API_KEY, AI_MODELS)   self-hosted OpenAI-compatible server (vLLM, SGLang, llama.cpp)
 *   OMNIROUTE_API_KEY (+ OMNIROUTE_BASE_URL, OMNIROUTE_SMART_MODEL, OMNIROUTE_FAST_MODEL)
 *                                            OmniRoute gateway, default http://localhost:20128/v1,
 *                                            model "auto" (OmniRoute picks) unless a combo is named
 *   GROQ_API_KEY, CEREBRAS_API_KEY, TOGETHER_API_KEY, FIREWORKS_API_KEY,
 *   DEEPINFRA_API_KEY, OPENROUTER_API_KEY
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN   Workers AI
 *   OLLAMA_BASE_URL                         local Ollama, e.g. http://localhost:11434/v1
 *
 * Tuning:
 *   AI_MODEL_MAP     JSON {"host": {"canonical-id": "host model name"}} to add or override names
 *   AI_MODELS        "canonical=host-name,..." for AI_BASE_URL (default maps everything to AI_MODEL)
 *   AI_TIMEOUT_MS, AI_HEDGE_MS, AI_COOLDOWN_MS
 */
import { MODELS, PRESETS } from "./catalog.ts";
import { createRouter, type AiRouter, type Provider, type RouterOptions } from "./router.ts";

type Env = Record<string, string | undefined>;

function parsePairs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function providersFromEnv(env: Env = process.env): Provider[] {
  let overrides: Record<string, Record<string, string>> = {};
  if (env.AI_MODEL_MAP) {
    try {
      overrides = JSON.parse(env.AI_MODEL_MAP);
    } catch {
      throw new Error("AI_MODEL_MAP must be JSON like {\"groq\": {\"gpt-oss-120b\": \"openai/gpt-oss-120b\"}}");
    }
  }
  const list: Provider[] = [];

  if (env.AI_BASE_URL) {
    const models = parsePairs(env.AI_MODELS);
    if (Object.keys(models).length === 0 && env.AI_MODEL) models["self-hosted"] = env.AI_MODEL;
    list.push({ name: "self-hosted", baseUrl: env.AI_BASE_URL, apiKey: env.AI_API_KEY, models });
  }

  if (env.OMNIROUTE_API_KEY) {
    list.push({
      name: "omniroute",
      baseUrl: env.OMNIROUTE_BASE_URL ?? "http://localhost:20128/v1",
      apiKey: env.OMNIROUTE_API_KEY,
      models: {},
      tierModels: { smart: env.OMNIROUTE_SMART_MODEL ?? "auto", fast: env.OMNIROUTE_FAST_MODEL ?? env.OMNIROUTE_SMART_MODEL ?? "auto" },
    });
  }

  for (const preset of PRESETS) {
    if (preset.name === "ollama") {
      if (env.OLLAMA_BASE_URL) list.push({ name: "ollama", baseUrl: env.OLLAMA_BASE_URL, models: { ...preset.models } });
      continue;
    }
    const apiKey = preset.keyEnv ? env[preset.keyEnv] : undefined;
    if (apiKey) list.push({ name: preset.name, baseUrl: preset.baseUrl, apiKey, models: { ...preset.models } });
  }

  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN) {
    list.push({
      name: "cloudflare",
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`,
      apiKey: env.CLOUDFLARE_AI_TOKEN,
      models: {
        "gpt-oss-120b": "@cf/openai/gpt-oss-120b",
        "gpt-oss-20b": "@cf/openai/gpt-oss-20b",
        "qwen3-32b": "@cf/qwen/qwen3-30b-a3b-fp8",
      },
    });
  }

  for (const p of list) Object.assign(p.models, overrides[p.name] ?? {});

  const order = (env.AI_PROVIDER_ORDER ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (order.length) list.sort((a, b) => rank(order, a.name) - rank(order, b.name));
  // A gateway with no tier model and no per-model names can't serve anything.
  return list.filter((p) => Object.keys(p.models).length > 0 || p.tierModels?.smart || p.tierModels?.fast);
}

function rank(order: string[], name: string) {
  const i = order.indexOf(name);
  return i < 0 ? order.length : i;
}

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function routerFromEnv(env: Env = process.env, extra: Partial<RouterOptions> = {}): AiRouter {
  return createRouter({
    providers: providersFromEnv(env),
    timeoutMs: num(env.AI_TIMEOUT_MS),
    hedgeMs: num(env.AI_HEDGE_MS),
    cooldownMs: num(env.AI_COOLDOWN_MS),
    ...extra,
  });
}

/** Shared process-wide router, so health and cool-downs are shared by every caller. */
let shared: AiRouter | undefined;
export function sharedRouter(): AiRouter {
  return (shared ??= routerFromEnv());
}

export { MODELS };
