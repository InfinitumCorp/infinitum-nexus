# Open sources reviewed for Infinitum

Public repositories were checked on 2026-11-11. A repo is in this tree only when its license allows us to copy it. Everything else is named here so it is not fetched by accident.

## Vendored

| Upstream | License | Where | What it is |
|---|---|---|---|
| [yandex/speechkitcloud](https://github.com/yandex/speechkitcloud) | Apache-2.0 | `third_party/yandex-speechkit` | Browser voice client and speech protocol. The upstream OSX binary is not included. |
| [google/open-location-code](https://github.com/google/open-location-code) | Apache-2.0 | `third_party/google-open-location-code` | Plus Codes. HRVST calls this for every consented location sample. |

## Used through our own adapters

These stay upstream. `@infinitum/sense` speaks to them. We do not copy the trees: MediaPipe, H3 and whisper.cpp are large native or model projects, and copying them would not make the TypeScript apps build.

| Upstream | License | Used for |
|---|---|---|
| [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) | Apache-2.0 | Face boxes for redaction. Not a face-identity gallery. |
| [google/lyra](https://github.com/google/lyra) | Apache-2.0 | Low-bitrate speech codec. Named so a voice link can use it later. Not copied. |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT | Offline transcripts that feed the safety-command parser. |
| [uber/h3](https://github.com/uber/h3) | Apache-2.0 | Global cell index. Our geohash is the small stand-in for mission-scale fixes. |
| [mavlink/mavlink](https://github.com/mavlink/mavlink) | LGPL-3.0 generator, different terms on generated code | Already implemented, in our own words, in `@infinitum/drone-backend`. The generator is not copied. |
| [teslamotors/react-native-camera-kit](https://github.com/teslamotors/react-native-camera-kit) | MIT | Camera library. Not vendored: dropping it into FABRIC would change the app. |
| [facebookresearch/detectron2](https://github.com/facebookresearch/detectron2) and [segment-anything](https://github.com/facebookresearch/segment-anything) | Apache-2.0 | Meta detection and segmentation. Research stacks, not copied. |
| [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) | MIT | The runtime that would execute an on-device model. About 1.6 GB. Not copied. |
| [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice) | MIT | Voice model. About 216 MB. Transcripts can feed the same safety parser. Not copied. |
| [data-privacy-stack/presidio](https://github.com/data-privacy-stack/presidio) | MIT | Microsoft's PII redaction framework, now under that org. About 343 MB. HRVST already redacts email and phone. Not copied. |
| [meta-pytorch/opacus](https://github.com/meta-pytorch/opacus) | Apache-2.0 | Differential privacy for PyTorch training. Not a runtime the apps call. Not copied. |
| [palantir/blueprint](https://github.com/palantir/blueprint) | Apache-2.0 | A web UI kit. Not applied. Product UI is not being replaced. |

## Not copied, and why

| Asked | What is actually public | Decision |
|---|---|---|
| Anduril | `anduril/lattice-sdk-python` and sample apps | The Lattice SDK license forbids copying, modifying, or redistributing the SDK. It may only be used to build apps for Lattice. It is not in this repo. |
| SpaceX | CentOS kernel forks and a Minecraft script | No flight, Starlink, or vehicle software. Nothing to take. |
| Tesla vehicle software | Light Show, wraps, an old Roadster archive, Linux sources | Autopilot and the vehicle stack are not published. |
| xAI | `grok-1` (Apache-2.0 weights), `x-algorithm`, `grok-build`, `grok-prompts` (AGPL-3.0) | Weights and the feed ranker are not app libraries. AGPL prompts are not merged into proprietary apps. |
| Flock Safety | No company source. Public repos are third-party camera detectors. | Those detectors are not Infinitum code and are not imported. |
| Oracle | GraalVM, database drivers, OpenGrok | Not a sensor, voice, geo, or drone stack. |
| Snap | Valdi (UI), KeyDB | Not applied. UI is unchanged. |
| TikTok / ByteDance | Agent harnesses (deer-flow, UI-TARS) | Not merged. They would replace ARCHITECT rather than help it. |
| Telegram | `tdlib/td` (BSL-1.0) | Not merged into Infinitum apps. |
| CERN | ROOT, Geant4, tomography toolboxes | Scientific codes with incompatible or mixed licenses. Not a product fit. |
| Palantir Gotham / Foundry | Not published. Blueprint is a UI kit. | See above. |
| Apple | Containers, FoundationDB, SwiftNIO, Pkl, Turi Create, coremltools (BSD-3-Clause) | Siri, Core Location, Face ID, and the Neural Engine are not published. coremltools converts models for Apple devices. It is not a sensing runtime for these apps, and it is not copied. `ml-ferret` and `ml-mobileclip` have no SPDX license on the repo, so they are not copied. |
| Microsoft | VS Code, TypeScript, Playwright, ONNX Runtime, VibeVoice, Presidio, Deep3DFaceReconstruction | Windows, Azure Face, and Azure Maps are not these repos. ONNX Runtime, VibeVoice, and Presidio are MIT but hundreds of megabytes to over a gigabyte, so they stay upstream. The 3D face-reconstruction repo is a face model, not redaction, and is not imported. `FaceSynthetics` has no SPDX license. |
| Meta | Detectron2, Segment Anything, SAM 2, FAISS, AudioCraft, fairseq, Opacus | The production face-recognition and social graph are not published. FAISS is MIT and about 293 MB. AudioCraft generates audio. Neither is copied. Llama is excluded on purpose. See below. |
| Google, beyond the two rows above | MediaPipe and Lyra stay upstream. Gemma weights are a model, not an app library. Android, Maps, and Search are not published as product source. | Plus Codes are the piece that was small enough to compile into HRVST. |
| Israeli tech companies | Public orgs were listed on 2026-11-11. See below. | One small product library was not found that both fits these apps and may be copied. The ones that are public are too big, a different license, or a UI or malware-analysis tool. |

## Llama license

Llama 3 and Llama 4 use the Llama Community License, not Apache or MIT. Commercial use is allowed below a threshold. The parts that keep it out of this repo:

- If, on that version's release date, the licensee's products had more than 700 million monthly active users in the preceding month, none of the rights apply until Meta grants a separate license.
- A distributed product must say "Built with Llama" (Llama 4) or "Built with Meta Llama 3".
- A model trained or improved with Llama outputs, if distributed, must be named starting with "Llama".
- Outputs may not be used to improve a non-Llama model.
- The acceptable-use policy withholds the license for uses that risk death or bodily harm, including weapons. These apps include MIL products, so the weights are not wired in.
- Llama 4 does not grant the section 1(a) rights in its multimodal models to a company whose principal place of business is in the European Union. End users of a product are excepted.

`@infinitum/ai` already refuses Llama for the same reason: the license is not an OSI license.

## Israeli companies

Public repo counts are from GitHub on 2026-11-11. None of these trees are copied.

| Company | Public org | Repos | Why it is not in this tree |
|---|---|---|---|
| Wix | wix, wix-incubator, wix-playground | 19 + 662 + 427 | UI kits, Detox, and a 700 KB scheduling spec. UI is unchanged. |
| JFrog | jfrog | 311 | Supply-chain product. Not a sensing library. |
| Snyk | snyk | 240 | CLI has no SPDX id on the repo. Not copied. |
| Redis | redis, RedisLabs, redis-developer | 85 + 144 + 395 | Current Redis is not an OSI license. Not copied. |
| CyberArk | cyberark | 196 | Conjur and Summon are their vault. Secrets stay in our own store. |
| Check Point | CheckPointSW | 146 | The small MIT repos are malware unpackers, evasion notes, and a tracer that spoofs a machine so malware will run. Those are not product code and are not imported. |
| Aqua | aquasecurity | 215 | Trivy is Apache-2.0 and about 950 MB. It stays upstream. |
| Cloudinary | cloudinary | 140 | Media pipeline. Not copied. |
| StarkWare | starkware-libs | 78 | Cairo is Apache-2.0 and about 278 MB. Not copied. |
| Fireblocks | fireblocks | 70 | Custody SDK. Not a sensing library. |
| AI21 | AI21Labs | 31 | The Python SDK and tokenizer are Apache-2.0. Jamba weights use a separate license, so the model is not added next to the OSI models. |
| Elementor | elementor | 66 | GPL-3.0. Not merged into these apps. |
| Hailo | hailo-ai | 47 | Model zoo and apps are large. Drivers are GPL. Not copied. |
| Habana | HabanaAI | 48 | Accelerator stack. Not copied. |
| Mellanox | Mellanox | 248 | NIC and RDMA drivers. Not copied. |
| monday, Kaltura, AppsFlyer, ironSource, Taboola, Similarweb, Riskified, Forter, Fiverr, Playtika, Lightricks, SentinelOne, Wiz, Orca, Guardicore, Claroty, Cybereason, Deep Instinct, Axonius, Intezer, Hunters, Coralogix, Logz.io, env0, groundcover, Lumigo, Radware, Checkmarx, Qodo, Tabnine, run:ai, Moovit, Gong, AudioCodes | those orgs | from 1 to 157 | Samples, SDKs, and product tools. None is a small geo, voice, or drone library these apps can compile. |
| Mobileye, Elbit, Rafael, IAI, NSO, Cellebrite | no public product source | 0 | Nothing to take. Spyware and unpublished military systems are not imported from anywhere else either. |
