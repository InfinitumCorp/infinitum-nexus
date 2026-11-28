# Google open source: the top 50 repos and what Infinitum uses (2026-11-12)

Ranked by GitHub stars across `google`, `google-deepmind` and `google-research`, pulled 2026-11-12 with `gh api search/repositories`.
Google Search itself is not open source, and scraping it without a key breaks its terms, so Infinitum Search uses SearXNG, the Yandex Search API and Brave instead (`packages/ai/src/search`).

## In use now

| Repo | License | Where | What |
|---|---|---|---|
| [google/robotstxt](https://github.com/google/robotstxt) | Apache-2.0 | `packages/ai/src/search/search.mjs` | Google's robots.txt parser ported to JS with its conformance tests: the Infinitum Search crawler obeys robots.txt exactly the way Googlebot does. |
| [google-deepmind/gemma](https://github.com/google-deepmind/gemma) (Gemma 4 weights) | Apache-2.0 | `packages/ai/src/catalog.ts`, `workers-ai.ts` | `gemma-4-31b` (smart) and `gemma-4-26b-a4b` (fast) in the open-model router. Keyless via the Workers AI binding (`@cf/google/gemma-4-26b-a4b-it`) and via Ollama (`gemma4:31b`, `gemma4:26b`). Earlier Gemma versions (Gemma Terms of Use) stay out. |

## Next candidates (each its own change)

| Repo | License | For | Why |
|---|---|---|---|
| [google-research/timesfm](https://github.com/google-research/timesfm) | Apache-2.0 | Conjure | Pretrained time-series forecasting model as a baseline next to Conjure's own forecasts. |
| [google/magika](https://github.com/google/magika) | Apache-2.0 | Cumulus Drive, Mail attachments, Search crawler | File-type detection from content (ONNX model, JS/Rust/Python). |
| [google/langextract](https://github.com/google/langextract) | Apache-2.0 | Search, Mail, Exchange | Structured extraction with source grounding; the approach can run on our open models. |
| [google/sentencepiece](https://github.com/google/sentencepiece) | Apache-2.0 | @infinitum/ai | Token counting for context budgets. |
| [google/osv-scanner](https://github.com/google/osv-scanner) | Apache-2.0 | CI | Dependency vulnerability scan on Linux runners (free CI only). |
| [google/re2](https://github.com/google/re2) | BSD-3-Clause | Search | Linear-time regex for untrusted patterns. |
| [google/brotli](https://github.com/google/brotli) | MIT | Fabric relay | Compression. |
| [google/libphonenumber](https://github.com/google/libphonenumber) | Apache-2.0 | Cumulus ID | Phone number parsing and validation. |
| [google/or-tools](https://github.com/google/or-tools) | Apache-2.0 | Exchange | Optimisation (routing, scheduling). |

Not used: AlphaFold 3 (model weights are non-commercial), anything without an OSI license (`NOASSERTION` or `none` below), and military uses (out of scope).

## The 50

| # | Repo | Stars | License | Language | Description |
|---|---|---|---|---|---|
| 1 | [google/material-design-icons](https://github.com/google/material-design-icons) | 54282 | Apache-2.0 | - | Material Design icons by Google (Material Symbols) |
| 2 | [google/guava](https://github.com/google/guava) | 51921 | Apache-2.0 | Java | Google core libraries for Java |
| 3 | [google/zx](https://github.com/google/zx) | 45841 | Apache-2.0 | JavaScript | A tool for writing better scripts |
| 4 | [google/styleguide](https://github.com/google/styleguide) | 39817 | NOASSERTION | Emacs Lisp | Style guides for Google-originated open-source projects |
| 5 | [google/googletest](https://github.com/google/googletest) | 39730 | BSD-3-Clause | C++ | GoogleTest - Google Testing and Mocking Framework |
| 6 | [google/leveldb](https://github.com/google/leveldb) | 39537 | BSD-3-Clause | C++ | LevelDB is a fast key-value storage library written at Google that provides an ordered map |
| 7 | [google/langextract](https://github.com/google/langextract) | 39303 | Apache-2.0 | Python | A Python library for extracting structured information from unstructured text using LLMs w |
| 8 | [google-research/google-research](https://github.com/google-research/google-research) | 39159 | Apache-2.0 | Jupyter Notebook | Google Research |
| 9 | [google-research/timesfm](https://github.com/google-research/timesfm) | 35420 | Apache-2.0 | Python | TimesFM (Time Series Foundation Model) is a pretrained time-series foundation model develo |
| 10 | [google/comprehensive-rust](https://github.com/google/comprehensive-rust) | 33518 | Apache-2.0 | Rust | This is the Rust course used by the Android team at Google. It provides you the material t |
| 11 | [google/material-design-lite](https://github.com/google/material-design-lite) | 32194 | Apache-2.0 | HTML | Material Design Components in HTML/CSS/JS |
| 12 | [google-research/tuning_playbook](https://github.com/google-research/tuning_playbook) | 30441 | NOASSERTION | - | A playbook for systematically maximizing the performance of deep learning models. |
| 13 | [google/python-fire](https://github.com/google/python-fire) | 28228 | NOASSERTION | Python | Python Fire is a library for automatically generating command line interfaces (CLIs) from  |
| 14 | [google/flatbuffers](https://github.com/google/flatbuffers) | 26630 | Apache-2.0 | C++ | FlatBuffers: Memory Efficient Serialization Library |
| 15 | [google/gson](https://github.com/google/gson) | 24231 | Apache-2.0 | Java | A Java serialization/deserialization library to convert Java Objects into JSON and back |
| 16 | [google/skills](https://github.com/google/skills) | 23935 | Apache-2.0 | Python | Agent Skills for Google products and technologies |
| 17 | [google-research/harness2](https://github.com/google-research/harness2) | 23467 | Apache-2.0 | Python |  |
| 18 | [google/adk-python](https://github.com/google/adk-python) | 22185 | Apache-2.0 | Python | An open-source, code-first Python toolkit for building, evaluating, and deploying sophisti |
| 19 | [google/ExoPlayer](https://github.com/google/ExoPlayer) | 21931 | Apache-2.0 | Java | This project is deprecated and stale. The latest ExoPlayer code is available in https://gi |
| 20 | [google/fonts](https://github.com/google/fonts) | 20750 | none | HTML | Font files available from Google Fonts, and a public issue tracker for all things Google F |
| 21 | [google/filament](https://github.com/google/filament) | 20738 | Apache-2.0 | C++ | Filament is a real-time physically based rendering engine for Android, iOS, Windows, Linux |
| 22 | [google/gvisor](https://github.com/google/gvisor) | 19966 | Apache-2.0 | Go | Application Kernel for Containers |
| 23 | [google/cadvisor](https://github.com/google/cadvisor) | 19525 | NOASSERTION | Go | Analyzes resource usage and performance characteristics of running containers. |
| 24 | [google/magika](https://github.com/google/magika) | 18791 | Apache-2.0 | Rust | Fast and accurate AI powered file content types detection  |
| 25 | [google/libphonenumber](https://github.com/google/libphonenumber) | 18349 | Apache-2.0 | C++ | Google's common Java, C++ and JavaScript library for parsing, formatting, and validating i |
| 26 | [google/elephant-goldfish-model](https://github.com/google/elephant-goldfish-model) | 17666 | Apache-2.0 | Python | Open-source plugin for designing and reviewing software with agents |
| 27 | [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco) | 17638 | Apache-2.0 | C++ | Multi-Joint dynamics with Contact. A general purpose physics simulator. |
| 28 | [google/artemis](https://github.com/google/artemis) | 17261 | Apache-2.0 | Python | ARTEMIS turns natural-language instructions into reliable Android automation. It automates |
| 29 | [google-deepmind/deepmind-research](https://github.com/google-deepmind/deepmind-research) | 15270 | Apache-2.0 | Jupyter Notebook | This repository contains implementations and illustrative code to accompany DeepMind publi |
| 30 | [google/brotli](https://github.com/google/brotli) | 15114 | MIT | TypeScript | Brotli compression format |
| 31 | [google-deepmind/alphafold](https://github.com/google-deepmind/alphafold) | 14940 | Apache-2.0 | Python | Open source code for AlphaFold 2. |
| 32 | [google/ax](https://github.com/google/ax) | 14611 | Apache-2.0 | Go | Agent Executor (AX) is Google's open agentic orchestration runtime |
| 33 | [google/or-tools](https://github.com/google/or-tools) | 14364 | Apache-2.0 | C++ | Google's Operations Research tools: |
| 34 | [google/yapf](https://github.com/google/yapf) | 13987 | Apache-2.0 | Python | A formatter for Python files |
| 35 | [google/oss-fuzz](https://github.com/google/oss-fuzz) | 12946 | Apache-2.0 | Shell | OSS-Fuzz - continuous fuzzing for open source software. |
| 36 | [google-research/vision_transformer](https://github.com/google-research/vision_transformer) | 12771 | Apache-2.0 | Jupyter Notebook |  |
| 37 | [google/guice](https://github.com/google/guice) | 12732 | Apache-2.0 | Java | Guice (pronounced 'juice') is a lightweight dependency injection framework for Java 11 and |
| 38 | [google/sanitizers](https://github.com/google/sanitizers) | 12526 | NOASSERTION | C | AddressSanitizer, ThreadSanitizer, MemorySanitizer |
| 39 | [google/sentencepiece](https://github.com/google/sentencepiece) | 12168 | Apache-2.0 | C++ | Unsupervised text tokenizer for Neural Network-based text generation. |
| 40 | [google/osv-scanner](https://github.com/google/osv-scanner) | 11498 | Apache-2.0 | Go | Vulnerability scanner written in Go which uses the data provided by https://osv.dev |
| 41 | [google/go-github](https://github.com/google/go-github) | 11341 | BSD-3-Clause | Go | Go library for accessing the GitHub v3 API |
| 42 | [google/skia](https://github.com/google/skia) | 11026 | BSD-3-Clause | C++ | Skia is a complete 2D graphic library for drawing Text, Geometries, and Images.  See docum |
| 43 | [google/dopamine](https://github.com/google/dopamine) | 10931 | Apache-2.0 | Jupyter Notebook | Dopamine is a research framework for fast prototyping of reinforcement learning algorithms |
| 44 | [google/adk-recipes](https://github.com/google/adk-recipes) | 10610 | Apache-2.0 | Python | A collection of agent recipes, reference patterns, and vertical plugins built with Agent D |
| 45 | [google/auto](https://github.com/google/auto) | 10562 | Apache-2.0 | Java | A collection of source code generators for Java. |
| 46 | [google/benchmark](https://github.com/google/benchmark) | 10508 | Apache-2.0 | C++ | A microbenchmark support library |
| 47 | [google-deepmind/sonnet](https://github.com/google-deepmind/sonnet) | 9976 | Apache-2.0 | Python | TensorFlow-based neural network library |
| 48 | [google/go-cloud](https://github.com/google/go-cloud) | 9926 | Apache-2.0 | Go | The Go Cloud Development Kit (Go CDK): A library and tools for open cloud development in G |
| 49 | [google/re2](https://github.com/google/re2) | 9849 | BSD-3-Clause | C++ | RE2 is a fast, safe, thread-friendly alternative to backtracking regular expression engine |
| 50 | [google-deepmind/alphafold3](https://github.com/google-deepmind/alphafold3) | 8763 | Apache-2.0 | Python | AlphaFold 3 inference pipeline. |

Licenses: Apache-2.0, MIT and BSD-3-Clause code can be reused with attribution (keep the copyright notice and, for Apache-2.0, a NOTICE line). Gemma 4 weights are Apache-2.0.
