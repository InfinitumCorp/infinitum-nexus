# Open sources reviewed for Infinitum

Public repositories were checked on 2026-11-11. A repo is in this tree only when its license allows us to copy it. Everything else is named here so it is not fetched by accident.

## Vendored

| Upstream | License | Where | What it is |
|---|---|---|---|
| [yandex/speechkitcloud](https://github.com/yandex/speechkitcloud) | Apache-2.0 | `third_party/yandex-speechkit` | Browser voice client and speech protocol. The upstream OSX binary is not included. |

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
| Meta | Detectron2, Segment Anything, SAM 2, FAISS, AudioCraft, fairseq, Opacus | The production face-recognition and social graph are not published. FAISS is MIT and about 293 MB. AudioCraft generates audio. Neither is copied. Llama weights use the Llama community license, not a general grant, and are not in this repo. |
