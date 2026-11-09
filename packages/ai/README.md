# @infinitum/ai

Every Infinitum backend reaches AI through this package, and only open-weight models are used. A product calls `chat()` or `complete()`, and the router picks the model and host. Products never choose a model, and neither do their users.

## How switching works

- **Failover.** An error, timeout, rate limit, malformed tool call or empty reply sends the request straight to the next candidate.
- **Hedging.** If a candidate hasn't answered within `AI_HEDGE_MS` (default 5 s), the next one starts in parallel. The first good answer wins and the other request is cancelled.
- **Health.** A failing candidate cools down for a while:
  - Rate limits follow the host's `Retry-After`.
  - A bad key parks the whole host for 10 minutes.
  - A missing model parks that model.

  Cooled-down candidates recover on their own. Every caller in the process shares one router (`sharedRouter()`), so they all share this health state too.
- **Same format for every model.** Messages and tool calls use one neutral format. An agent can start on one model and finish on another.

## Hosts

Hosts are tried in this order. Set any subset of them; `AI_PROVIDER_ORDER=omniroute,cloudflare,...` reorders them.

| Variable | Host |
|---|---|
| `AI_BASE_URL` (+ `AI_API_KEY`, `AI_MODELS` or `AI_MODEL`) | Self-hosted vLLM / SGLang / llama.cpp |
| `OMNIROUTE_BASE_URL` and/or `OMNIROUTE_API_KEY` (+ `OMNIROUTE_SMART_MODEL`, `OMNIROUTE_FAST_MODEL`) | [OmniRoute](http://localhost:20128). Either variable turns it on; a local gateway needs no key. The default URL is `http://localhost:20128/v1` and the default model is `auto`. Name a combo to pin one. |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `DEEPINFRA_API_KEY`, `OPENROUTER_API_KEY` | Hosted open models |
| `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` | Cloudflare Workers AI |
| `OLLAMA_BASE_URL` | Local Ollama, e.g. `http://localhost:11434/v1` |

Deployed services can't reach an OmniRoute running on a laptop. In production, point `OMNIROUTE_BASE_URL` at a hosted OmniRoute and keep at least one backup host configured. Workers AI is the natural backup because every product's domain is already on Cloudflare.

## Models

These are the canonical ids, in tier order:

- **smart:** `gpt-oss-120b` (Apache-2.0), `qwen3-235b` (Apache-2.0), `deepseek-v3` (MIT)
- **fast:** `gpt-oss-20b` (Apache-2.0), `qwen3-32b` (Apache-2.0)

Only OSI-licensed models are included. Llama is excluded because its custom license isn't open source.

Each host's model names are listed in `src/catalog.ts`. Override or add names with `AI_MODEL_MAP='{"groq":{"gpt-oss-120b":"..."}}'`, without touching code.

## Use

```ts
import { sharedRouter } from "@infinitum/ai";
const ai = sharedRouter();
const text = await ai.complete("You are SCALVS.", "Summarize this thread…", { tier: "fast" });
const reply = await ai.chat({ system, messages, tools }); // tool calling for agents
```

For tests, import from `@infinitum/ai/testing`: `scriptedRouter`, `queuedRouter`, `textReply` and `toolReply` script the replies without any network.

## Free setup

Nothing here needs a paid plan.

- **Local:** OmniRoute routes to Ollama on the same machine. The `infinitum-open` combo lists the local models (qwen3:8b, gpt-oss:20b). Set `OMNIROUTE_BASE_URL=http://localhost:20128/v1` and `OMNIROUTE_SMART_MODEL=infinitum-open`. A local gateway needs no key.
- **Deployed on Cloudflare Workers:** declare the AI binding (`"ai": { "binding": "AI" }`) and add `workersAiProvider(env.AI)` to the router's providers. It runs Workers AI open models inside Cloudflare's free daily allowance with no token. When the allowance runs out, the router cools the host down and moves to the next one.
