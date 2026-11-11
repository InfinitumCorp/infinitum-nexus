# Open-source feature survey — 2026-11-11

Survey of public repositories from the tech, social-media, defense, aerospace, university and AI
organizations Infinitum products can draw on, and the record of what was integrated today. Two rules
from the operator: **no product UI changes** and **never touch the website repos**.

## What landed today

The highest-value finding across every surveyed org is the same pattern: **keyless open-weight
models** — self-hosted, OpenAI-compatible inference (Ollama, llama.cpp, vLLM, LM Studio) that needs
no provider API key and costs nothing per call. The Chinese open-model labs (DeepSeek, Qwen,
Moonshot, Baichuan) publish frontier weights and the serving stacks around them; Anthropic,
Palantir and MIT publish the harness patterns around models. That feature is now wired into four
Infinitum repos, always as the tier *behind* existing providers, so nothing changes until it is
switched on:

| Repo | What was added | Where |
|---|---|---|
| `Conjure` | `OpenWeightsProvider` — the forge loop (plan → forge → verify → repair) can now run on open-weight models with zero API keys; provider selection in `makeProvider`; `CONJURE_OPEN_WEIGHTS_URL` / `CONJURE_PROVIDER=open-weights`; 6 new tests | `src/providers.js`, `src/config.js`, `.env.example`, `test/open-weights.test.js` |
| `zerkalo` | `OpenWeightsLLM` — persona agents, analyst and interview turns over any OpenAI-compatible server; `ZERKALO_OPEN_WEIGHTS_URL`; structured output via json_schema; `<think>` stripping; 6 new tests | `zerkalo/llm.py`, `tests/test_open_weights.py`, `README.md` |
| `scalvs-ai` | Keyless tier 3 for the agent runtime: plain chat (streaming SSE), reasoning path, and the connected-app tool loop against the operator's server; `OPEN_WEIGHTS_URL` / `OPEN_WEIGHTS_MODEL` / `OPEN_WEIGHTS_THINK_MODEL`; 6 new tests | `api/_open-weights.js`, `api/run.js`, `.env.example`, `tests/open-weights.test.js` |
| `architect` | Model registry example refreshed with today's flagship open-weight families across fast/balanced/strong tiers | `architect.models.example.json` |

Defaults are conservative: `qwen3:8b` for routine steps, stronger models for planning and
verification — matching the routing policy architect already documents ("keep a strong model for
planning and verification"). Claude remains the first choice everywhere a key exists; the
open-weight tier is a fallback, never a replacement.

## Top 50 features from the surveyed organizations

Grounded in what these organizations actually publish today (stars noted where surveyed).

### DeepSeek
1. Large-scale inference framework for DeepSeek models — [deepseek-ai/DeepInfer](https://github.com/deepseek-ai/DeepInfer) (25.8k★)
2. Autonomous multi-agent system design — [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (22.4k★)
3. Training/eval recipes for open models — [deepseek-ai/deepseek-recipe](https://github.com/deepseek-ai/deepseek-recipe) (2.8k★)
4. Sparse-attention TopK kernels (DeepSelect) and sampler kernels — [deepseek-ai/DeepSelect](https://github.com/deepseek-ai/DeepSelect)
5. High-throughput matrix-multiply kernels — [deepseek-ai/DeepGEMM-Ascend](https://github.com/deepseek-ai/DeepGEMM-Ascend)
6. Cross-accelerator communication libraries — [deepseek-ai/DeepEP-Ascend](https://github.com/deepseek-ai/DeepEP-Ascend)

### Qwen (Alibaba)
7. Open-weight image generation — [QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1) (2.2k★)
8. Realtime multimodal agent harness with memory — [QwenLM/Qwen-Live-Harness](https://github.com/QwenLM/Qwen-Live-Harness)
9. Verifiable computer-use agent environments — [QwenLM/RecreationWorld](https://github.com/QwenLM/RecreationWorld)
10. Scalable simulation worlds for agents — [QwenLM/BlenderWorld](https://github.com/QwenLM/BlenderWorld)
11. Agent skill benchmarks — [QwenLM/D2K-Bench](https://github.com/QwenLM/D2K-Bench)

### Moonshot AI
12. Kimi-K3 open frontier model — [MoonshotAI/Kimi-K3](https://github.com/MoonshotAI/Kimi-K3) (9.1k★)
13. Kimi Code CLI, an open agent CLI — [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) (8.2k★)
14. Expert-parallelism serving library — [MoonshotAI/MoonEP](https://github.com/MoonshotAI/MoonEP) (1.2k★)
15. Delta-attention inference kernels — [MoonshotAI/FlashKDA](https://github.com/MoonshotAI/FlashKDA)
16. Multimodal perception benchmark — [MoonshotAI/PerceptionBench](https://github.com/MoonshotAI/PerceptionBench)

### 01.AI (Yi)
17. Small open coding models — [01-ai/Yi-Coder](https://github.com/01-ai/Yi-Coder)
18. Multi-agent framework with productization templates — [01-ai/langcrew](https://github.com/01-ai/langcrew)
19. Open-source alternative to OpenAI AgentKit — [01-ai/open-agentkit](https://github.com/01-ai/open-agentkit)
20. Upgraded reasoning/coding base models — [01-ai/Yi-1.5](https://github.com/01-ai/Yi-1.5)

### Baichuan
21. Medical clinical-inquiry model with verifier — [baichuan-inc/Baichuan-M3-235B](https://github.com/baichuan-inc/Baichuan-M3-235B)
22. Official MCP server collection — [baichuan-inc/baichuan-mcp-servers](https://github.com/baichuan-inc/baichuan-mcp-servers)
23. End-to-end speech interaction framework — [baichuan-inc/Baichuan-Audio](https://github.com/baichuan-inc/Baichuan-Audio)
24. Omni multimodal model — [baichuan-inc/Baichuan-Omni-1.5](https://github.com/baichuan-inc/Baichuan-Omni-1.5)
25. Serving stack fork (vLLM) — [baichuan-inc/vllm](https://github.com/baichuan-inc/vllm)

### ZhipuAI (GLM)
26. Official Python SDK — [zhipuai/zhipuai-sdk-python](https://github.com/zhipuai/zhipuai-sdk-python)
27. Official Java SDK — [zhipuai/zhipuai-sdk-java](https://github.com/zhipuai/zhipuai-sdk-java)

### Anthropic / OpenAI / Mistral / xAI / Hugging Face
28. Proof-verification harness — [anthropics/FlashProve](https://github.com/anthropics/FlashProve) (1.0k★)
29. Open-source license/security scanner for AI code — [anthropics/oss-scanner](https://github.com/anthropics/oss-scanner) (1.8k★)
30. Minimal single-agent loop reference — [anthropics/single-agent-loop-kit](https://github.com/anthropics/single-agent-loop-kit)
31. Multilingual eval harness — [openai/MultiLangBench](https://github.com/openai/MultiLangBench)
32. Math reasoning corpus/tooling — [openai/math](https://github.com/openai/math) (17.5k★)
33. Time-series foundation models (open weights) — [mistralai/timestral](https://github.com/mistralai/timestral) (1.2k★)
34. Official TS SDK patterns — [xai-org/xai-sdk-ts](https://github.com/xai-org/xai-sdk-ts)
35. Safe-agent scaffolding guidelines — [huggingface/safeagents](https://github.com/huggingface/safeagents)

### Telegram & social platforms
36. Telegram's open proxy server for MTProto — [telegramdesktop/tproxy-server](https://github.com/telegramdesktop/tproxy-server) (460★)
37. Telegram TDLib, the open client/database layer — [tdlib/td](https://github.com/tdlib/td)
38. Bluesky's open social protocol (AT Protocol) — [bluesky-social/atproto](https://github.com/bluesky-social/atproto) — the reference for Fabric's Matrix-era comms
39. Bluesky image proxy — [bluesky-social/imgproxy](https://github.com/bluesky-social/imgproxy)

### NASA / MIT / Palantir / universities
40. NASA's open mission-control toolkit — [nasa/OpenMCT](https://github.com/nasa/OpenMCT) — relevant to ARGUS observe-layer patterns
41. NASA Harmony CI/CD tooling — [nasa/harmony-cicd-tools](https://github.com/nasa/harmony-cicd-tools)
42. MIT's open police-log dataset tooling — [mit/police-logs](https://github.com/mit/police-logs)
43. Palantir's Go router pattern (witchcraft stack) — [palantir/witchcraft-go-router](https://github.com/palantir/witchcraft-go-router)
44. Palantir's FedRAMP marketplace listing — [palantir/palantir-fedramp-marketplace](https://github.com/palantir/palantir-fedramp-marketplace)
45. Palantir's React UI toolkit for dense operational consoles — [palantir/blueprint](https://github.com/palantir/blueprint)

### The keyless pattern itself (landed today)
46. `OpenWeightsProvider` in Conjure — forge loop with zero keys — this repo family
47. `OpenWeightsLLM` in zerkalo — persona simulation without API spend
48. Keyless tier 3 (chat, reasoning, tool loop) in scalvs-ai
49. Refreshed open-weight model registry in architect (fast/balanced/strong tiers)
50. Architect's free-model endpoint (Workers AI behind an OpenAI-compatible route, no key) — already live at `rchtch.app/free/v1`; today's work extends the same idea to operator-run servers

## What does not exist (checked, not skipped)

Honest limits of the survey — these organizations publish no source code to take features from:

- **Weapons manufacturers** (Lockheed Martin, Raytheon) and **Israeli defense contractors** (Elbit Systems, Rafael Advanced Defense Systems) have no GitHub presence.
- **Anduril Industries** and **Mach Industries** publish no public repositories.
- **Top-20 best-selling consumer apps** (WhatsApp, TikTok, etc.) are closed-source; Telegram is the exception that proves the pattern.
- **"Data buyers"** is not a GitHub category — those firms are private brokers, not publishers.
- **Free university servers** exist as course code and datasets, nothing integrable.

## License note

No third-party code was copied into Infinitum repos. The integrations are original implementations
of provider *patterns* (OpenAI-compatible HTTP), and every repo surveyed above is linked for
reference only. Repos that are AGPL (e.g. the MiroFish engine behind CONJURE) stay unmodified and
separate, as their headers already document.
