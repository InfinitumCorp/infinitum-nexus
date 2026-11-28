# Open-source feature survey II — 2026-11-11

Second wave: 50 more organizations surveyed (plus re-verification of wave one's links). Same rules
from the operator: **no product UI changes**, **never touch the website repos**. All links below were
checked against the GitHub API on 2026-11-11; star counts as returned.

## Correction to survey I

- **Anduril does publish code**: the org exists as [anduril](https://github.com/anduril) (18 public
  repos) — its Lattice SDKs and sample apps, e.g. [anduril/lattice-sdk-python](https://github.com/anduril/lattice-sdk-python)
  and the [sample-app-auto-reconnaissance](https://github.com/anduril/sample-app-auto-reconnaissance)
  integration examples. Survey I checked the wrong org slug (`andurilindustries`) and wrongly reported
  "no public repos". The ODIN/ARGUS line's Lattice integration notes now have a real upstream to mirror.
- Raytheon (org exists, 0 public repos), Lockheed Martin, Elbit and Rafael remain genuinely empty.

## What landed today

**Model-server resilience** — the highest-value pattern from the payment, e-commerce and
observability orgs in this wave (Stripe-style retry with Retry-After, outlier-ejecting circuit
breakers from service proxies, and OWASP's LLM data-leak guidance), built for the open-weight
tier from yesterday:

| Repo | What |
|---|---|
| `scalvs-ai` | `api/_resilience.js` + wired into every open-weights call site: retry with exponential backoff (Retry-After honoured), failover across a comma-separated `OPEN_WEIGHTS_URL` list, circuit breakers per server, and secret redaction of prompts before they leave the Worker |
| `Conjure` | `src/resilience.js` — byte-identical copy (header note cross-references), wired into `OpenWeightsProvider` the same way |
| Tests | 16 new in scalvs-ai (`tests/resilience.test.js`), 2 new in Conjure — all green |

Env switches (both repos): `OPEN_WEIGHTS_RETRIES` / `CONJURE_OPEN_WEIGHTS_RETRIES` (default 2),
`...RETRY_BASE_MS` (default 400), `...REDACT=off` (redaction is on by default — API keys, GitHub
tokens, AWS keys, JWTs, private keys, bearer tokens are stripped from prompts before they are sent
to a model server). No UI changes; Claude and Workers AI paths untouched.

## The 50 organizations

### Payments & commerce
1. **Stripe** — per-language API SDKs with battle-tested webhook signature verification and
   idempotency conventions ([stripe-node](https://github.com/stripe/stripe-node), 4.6k★)
2. **Shopify** — the Liquid templating language powering storefronts ([liquid](https://github.com/Shopify/liquid), 11.9k★)
3. **Docker** — Compose file patterns for multi-service dev environments ([compose](https://github.com/docker/compose), 38.7k★)

### Infrastructure & data
4. **HashiCorp** — Terraform's provider/plugin architecture ([terraform](https://github.com/hashicorp/terraform), 50.2k★)
5. **Cloudflare** — cfssl PKI tooling behind edge TLS ([cfssl](https://github.com/cloudflare/cfssl), 9.5k★)
6. **Vercel** — Next.js app router and SWR data-fetching primitives ([next.js](https://github.com/vercel/next.js), 143k★; [swr](https://github.com/vercel/swr), 32k★)
7. **Grafana Labs** — the Grafana observability console ([grafana](https://github.com/grafana/grafana), 78k★), k6 load testing ([k6](https://github.com/grafana/k6), 32k★) and Loki log aggregation ([loki](https://github.com/grafana/loki), 29k★)
8. **Elastic** — Elasticsearch/Kibana/Logstash search-and-observability stack ([elasticsearch](https://github.com/elastic/elasticsearch), 79k★)
9. **MongoDB** — the `mongo` shell and drivers ([mongo](https://github.com/mongodb/mongo), 29k★)
10. **Redis** — the in-memory data store and go-redis client ([redis](https://github.com/redis/redis), 77k★)
11. **Confluent** — Kafka clients and Schema Registry ([confluent-kafka-go](https://github.com/confluentinc/confluent-kafka-go), 5.2k★)
12. **Databricks** — Spark learning materials and Koalas ([learning-spark](https://github.com/databricks/learning-spark), 3.9k★)
13. **Snowflake** — connectors and the ArcticInference inference stack ([ArcticInference](https://github.com/snowflakedb/ArcticInference), 495★)
14. **Kong** — the Kong API gateway and Insomnia API client ([kong](https://github.com/Kong/kong), 44k★; [insomnia](https://github.com/Kong/insomnia), 40k★)

### Web & app engineering
15. **Apple** — FoundationDB distributed database ([foundationdb](https://github.com/apple/foundationdb), 16.9k★) and SwiftNIO networking ([swift-nio](https://github.com/apple/swift-nio), 8.6k★)
16. **Uber** — Baseweb design system and RIBs architecture ([baseweb](https://github.com/uber/baseweb), 9k★)
17. **Airbnb** — the JavaScript style guide and Lottie animations ([javascript](https://github.com/airbnb/javascript), 148k★; [lottie-web](https://github.com/airbnb/lottie-web), 32k★)
18. **GitHub** — the gitignore collection and Scientist refactor-experiment pattern ([gitignore](https://github.com/github/gitignore), 176k★; [scientist](https://github.com/github/scientist), 7.8k★)
19. **GitLab** — the full DevOps platform source ([gitlabhq](https://github.com/gitlabhq/gitlabhq), 24.6k★)

### Open-weight models & inference
20. **Ollama** — the local model server that is now the default backend of Infinitum's keyless tier ([ollama](https://github.com/ollama/ollama), 187k★)
21. **ggml-org** — llama.cpp inference engine and whisper.cpp speech recognition ([llama.cpp](https://github.com/ggml-org/llama.cpp), 134k★; [whisper.cpp](https://github.com/ggml-org/whisper.cpp), 55k★)
22. **vLLM** — high-throughput serving engine ([vllm](https://github.com/vllm-project/vllm), 97k★)
23. **PyTorch** — the reference training framework ([pytorch](https://github.com/pytorch/pytorch), 105k★)
24. **NVIDIA** — CUTLASS GPU kernels and RAPIDS cuDF ([cutlass](https://github.com/NVIDIA/cutlass), 10.7k★; [cudf](https://github.com/rapidsai/cudf))
25. **Intel** — low-level tracing and media libraries ([libipt](https://github.com/intel/libipt))

### Chinese open-model & agent labs
26. **ByteDance** — the Elkeid host-security agent and Sonic serialization ([Elkeid](https://github.com/bytedance/Elkeid), 2.7k★)
27. **Tencent** — ncnn mobile inference and MMKV storage ([ncnn](https://github.com/Tencent/ncnn), 24k★; [MMKV](https://github.com/Tencent/MMKV), 19k★)
28. **Alibaba** — Canal data sync and Druid analytics ([canal](https://github.com/alibaba/canal), 30k★; [druid](https://github.com/alibaba/druid), 28k★)
29. **Baidu** — the amis low-code frontend framework ([amis](https://github.com/baidu/amis), 19k★)
30. **PaddlePaddle** — PaddleOCR document intelligence ([PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR), 93k★)
31. **THUDM (Tsinghua)** — GLM open models and AgentBench ([GLM](https://github.com/THUDM/GLM), 3.7k★; [AgentBench](https://github.com/THUDM/AgentBench), 3.8k★)
32. **InternLM (Shanghai AI Lab)** — lmdeploy serving toolkit and MindSearch agent ([lmdeploy](https://github.com/InternLM/lmdeploy), 8.1k★; [MindSearch](https://github.com/InternLM/MindSearch), 7k★)
33. **OpenBMB (Tsinghua)** — MiniCPM-V multimodal models, ChatDev multi-agent coding, VoxCPM voice ([MiniCPM-V](https://github.com/OpenBMB/MiniCPM-V), 27k★; [ChatDev](https://github.com/OpenBMB/ChatDev), 35k★; [VoxCPM](https://github.com/OpenBMB/VoxCPM), 42k★)
34. **ai-forever (Sber)** — Kandinsky image models and Russian GPT corpora ([Kandinsky-2](https://github.com/ai-forever/Kandinsky-2), 2.8k★; [ru-gpts](https://github.com/ai-forever/ru-gpts), 2.1k★)
35. **Yandex** — gixy nginx auditor and Odyssey PostgreSQL pooler ([gixy](https://github.com/yandex/gixy), 8.6k★; [odyssey](https://github.com/yandex/odyssey), 3.6k★)

### Security & intelligence
36. **CrowdStrike** — falconpy, the Falcon platform SDK ([falconpy](https://github.com/CrowdStrike/falconpy), 521★)
37. **Mandiant (Google)** — FLARE-VM reverse-engineering tooling and capa capability analysis ([flare-vm](https://github.com/mandiant/flare-vm), 9.3k★; [capa](https://github.com/mandiant/capa), 6.3k★)
38. **Trail of Bits** — the algo VPN deployment and security publications ([algo](https://github.com/trailofbits/algo), 30k★)
39. **ProjectDiscovery** — nuclei vulnerability scanning and katana crawling ([nuclei](https://github.com/projectdiscovery/nuclei), 33k★; [katana](https://github.com/projectdiscovery/katana), 18k★)
40. **Wazuh** — open-source SIEM/XDR ([wazuh](https://github.com/wazuh/wazuh), 18k★)
41. **Cisco Talos** — ClamAV antivirus ([clamav](https://github.com/Cisco-Talos/clamav), 7.5k★)
42. **OWASP** — the Web Security Testing Guide and Mobile Application Security Testing Guide ([wstg](https://github.com/OWASP/wstg), 10k★; [mastg](https://github.com/OWASP/mastg), 13k★)
43. **Zeek** — the Zeek network-security monitor ([zeek](https://github.com/zeek/zeek), 8.2k★)

### Secure communications
44. **Signal** — fully open Signal clients ([Signal-Android](https://github.com/signalapp/Signal-Android), 30k★; [Signal-Desktop](https://github.com/signalapp/Signal-Desktop), 17k★)
45. **Element (Matrix)** — element-web and the Synapse homeserver ([element-web](https://github.com/element-hq/element-web), 14k★; [synapse](https://github.com/element-hq/synapse), 4.8k★) — Fabric's Matrix stack upstream
46. **Tor Project** — the tor daemon behind VEIL's Tor-first design ([tor](https://github.com/torproject/tor), 5.1k★)

### Orchestration & workflow
47. **Temporal** — durable-execution workflow engine ([temporal](https://github.com/temporalio/temporal), 24k★)
48. **Envoy** — the edge/service proxy and its rate-limit service ([envoy](https://github.com/envoyproxy/envoy), 29k★; [ratelimit](https://github.com/envoyproxy/ratelimit), 2.7k★)
49. **Prometheus** — the monitoring system and exporters ([prometheus](https://github.com/prometheus/prometheus), 68k★)
50. **OpenTelemetry** — vendor-neutral telemetry collectors and specs ([opentelemetry-collector](https://github.com/open-telemetry/opentelemetry-collector), 7.8k★)

### Checked, nothing to take
- **Raytheon** — GitHub org exists, zero public repos. **Mach Industries** — org exists, zero public
  repos. GitLab publishes only the enterprise edition mirror under `gitlab-org` (2 repos);
  the real source is `gitlabhq`. sber-ai (Sber AI org) does not exist.

## Where these patterns fit Infinitum products

- **scalvs-ai / architect / Conjure**: the resilience layer (today), plus observability hooks —
  a Prometheus/OTel-style metrics export from the endpoint pool is the natural next step.
- **1mind / ODIN**: Signal's client architecture and Element's Matrix stack are the reference
  implementations for Fabric and ÆTHER; Temporal's durable-execution model fits Argus workflow
  supervision; Mandiant/Talos/Wazuh patterns map to the ARGUS military edition's threat posture.
- **hrvst / cumulus-exchange**: PaddleOCR (document capture), PaddlePaddle serving, and OWASP
  testing guides for the data-exchange security posture.
- **VEIL**: Tor daemon and Trail of Bits algo as hardening references.

## License note

No third-party code was copied. Today's additions are original implementations of published
patterns (retry/backoff, circuit breaking, secret redaction), with the upstream projects linked
for reference only.
