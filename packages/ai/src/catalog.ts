/**
 * Open-weight models and the hosts that serve them.
 *
 * Every model here is released under an OSI-approved license (Apache 2.0 or
 * MIT), so any of them can also be self-hosted with vLLM, SGLang, llama.cpp or
 * Ollama. Llama models are deliberately excluded: their custom license is not
 * open source (InfinitumCorp/RULES reports/oss-reuse.md). Hosts all speak the OpenAI-compatible
 * /chat/completions API, which is what lets the router move a conversation
 * from one model or host to another mid-task.
 *
 * Host model names drift; override any of them with AI_MODEL_MAP (see
 * providersFromEnv) instead of editing code.
 */

export type Tier = "fast" | "smart";

export interface OpenModel {
  /** Canonical id used across Infinitum. */
  id: string;
  label: string;
  license: string;
  tier: Tier;
  /** Reliable OpenAI-style function calling. */
  tools: boolean;
  contextTokens: number;
}

export const MODELS: readonly OpenModel[] = [
  { id: "gpt-oss-120b", label: "gpt-oss 120B", license: "Apache-2.0", tier: "smart", tools: true, contextTokens: 131_072 },
  { id: "qwen3-235b", label: "Qwen3 235B A22B", license: "Apache-2.0", tier: "smart", tools: true, contextTokens: 131_072 },
  { id: "deepseek-v3", label: "DeepSeek V3", license: "MIT", tier: "smart", tools: true, contextTokens: 131_072 },
  { id: "gpt-oss-20b", label: "gpt-oss 20B", license: "Apache-2.0", tier: "fast", tools: true, contextTokens: 131_072 },
  { id: "qwen3-32b", label: "Qwen3 32B", license: "Apache-2.0", tier: "fast", tools: true, contextTokens: 32_768 },
];

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  /** Env var holding the key. Omitted for local servers that need none. */
  keyEnv?: string;
  /** Canonical model id -> this host's model name. */
  models: Record<string, string>;
}

/** Ordered fastest-first: the router tries hosts in this order unless AI_PROVIDER_ORDER says otherwise. */
export const PRESETS: readonly ProviderPreset[] = [
  {
    name: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    models: {
      "gpt-oss-120b": "openai/gpt-oss-120b",
      "gpt-oss-20b": "openai/gpt-oss-20b",
      "qwen3-32b": "qwen/qwen3-32b",
    },
  },
  {
    name: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    keyEnv: "CEREBRAS_API_KEY",
    models: {
      "gpt-oss-120b": "gpt-oss-120b",
      "qwen3-32b": "qwen-3-32b",
    },
  },
  {
    name: "together",
    baseUrl: "https://api.together.xyz/v1",
    keyEnv: "TOGETHER_API_KEY",
    models: {
      "gpt-oss-120b": "openai/gpt-oss-120b",
      "gpt-oss-20b": "openai/gpt-oss-20b",
      "deepseek-v3": "deepseek-ai/DeepSeek-V3",
      "qwen3-235b": "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
    },
  },
  {
    name: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnv: "FIREWORKS_API_KEY",
    models: {
      "gpt-oss-120b": "accounts/fireworks/models/gpt-oss-120b",
      "gpt-oss-20b": "accounts/fireworks/models/gpt-oss-20b",
      "deepseek-v3": "accounts/fireworks/models/deepseek-v3",
      "qwen3-235b": "accounts/fireworks/models/qwen3-235b-a22b",
    },
  },
  {
    name: "deepinfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    models: {
      "gpt-oss-120b": "openai/gpt-oss-120b",
      "gpt-oss-20b": "openai/gpt-oss-20b",
      "deepseek-v3": "deepseek-ai/DeepSeek-V3",
      "qwen3-235b": "Qwen/Qwen3-235B-A22B",
    },
  },
  {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
    models: {
      "gpt-oss-120b": "openai/gpt-oss-120b",
      "gpt-oss-20b": "openai/gpt-oss-20b",
      "deepseek-v3": "deepseek/deepseek-chat",
      "qwen3-235b": "qwen/qwen3-235b-a22b",
      "qwen3-32b": "qwen/qwen3-32b",
    },
  },
  {
    name: "ai21",
    baseUrl: "https://api.ai21.com/studio/v1",
    keyEnv: "AI21_API_KEY",
    // Jamba is not an OSI license, so it is not in MODELS. Name it with AI_MODEL_MAP.
    models: {},
  },
  {
    name: "ollama",
    baseUrl: "http://localhost:11434/v1",
    models: {
      "gpt-oss-120b": "gpt-oss:120b",
      "gpt-oss-20b": "gpt-oss:20b",
      "qwen3-32b": "qwen3:32b",
    },
  },
];
