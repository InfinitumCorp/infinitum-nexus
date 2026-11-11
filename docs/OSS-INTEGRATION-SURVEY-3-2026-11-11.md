# Open-source integration survey III — 2026-11-11

Third wave. Surveys I and II are not repeated here. Every org and repo below was checked against the GitHub API on 2026-11-11 (stars and the license field are what that API returned). Where the API said `NOASSERTION` or returned no license, the repo's license file was opened.

Rules for this pass: permissive code only (MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0). No GPL, AGPL, LGPL, unlicensed, source-available, or non-commercial code is copied. No product UI changes. No website repos. Integrated code is **on by default**. A switch may turn it off. Face comparison in ei·det·ic is on as well, and it still refuses to run unless consent and purpose already allow it.

## What was integrated

| Product repo | Upstream | License | Commit / pin | Where | Default |
|---|---|---|---|---|---|
| `flower-pollen` | [mapbox/cheap-ruler](https://github.com/mapbox/cheap-ruler) | ISC | `2ff154f9f09a14a985e25b4639551e55a0fdbfa7` (v4.1.1), vendored `index.js` | Sector bearing when assigning survey cells, and `separationM` on the track API | On. `FP_CHEAP_RULER=off` restores the old bearing and drops `separationM` |
| `prpgnd` | [growthbook/growthbook](https://github.com/growthbook/growthbook) `packages/sdk-js` | MIT for the SDK. Enterprise License on three directories that were not installed | npm `@growthbook/growthbook@2.0.0`, gitHead `e43a8ef36ec71c71d4789cecbd4f0f0c93a8191a` | Local subject-line assignment. The readiness handler returns it. The desks only read `ready` | On. `PRPGND_EXPERIMENTS=off` assigns nothing. No call to GrowthBook's network |
| `eidetic` | [justadudewhohacks/face-api.js](https://github.com/justadudewhohacks/face-api.js) `src/euclideanDistance.ts` | MIT | `a86f011d72124e5fb93e59d5c4ab98f699dd5c9c` | `POST /v1/face-distance`, 1:1 only, after the existing consent and purpose gate | On. `EIDETIC_FACE_DISTANCE=off` returns 404 and does not compare. Missing consent returns 403 and does not compare. Vectors are not stored |
| `zerkalo` | [NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) `schema.py`, `validator.py`, `utils.py` | MIT | `ea3c4723e4cefdac760d483ccac6c8a428c95ab8` | Open-weight agent actions are checked with `validate_function_call_schema` | On. `ZERKALO_HERMES_VALIDATE=off` skips it. `jsonschema==4.23.0` and `art==6.5` are pinned because those files import them |

## The 50 organizations

| # | Org | Category | Key repo | License (API, then file when the API was unclear) | Stars | Fits | Integrated |
|---|---|---|---|---|---|---|---|
| 1 | cisagov | GovCon | [RedEye](https://github.com/cisagov/RedEye) | BSD-3-Clause | 2768 | ARGUS / ODIN review of an engagement log | No. Full web app, not a library |
| 2 | usnistgov | GovCon | [OSCAL](https://github.com/usnistgov/OSCAL) | API `NOASSERTION`. File: US government public domain and CC0 1.0 | 967 | Compliance catalogs for Cumulus exchange | No. CC0 is outside the copy set used for this pass |
| 3 | GSA | GovCon | [data](https://github.com/GSA/data) | API returned no license. No LICENSE file in the repo root | 2355 | Open-data publishing | No. Unlicensed at the root |
| 4 | 18F | GovCon | [domain-scan](https://github.com/18F/domain-scan) | API `NOASSERTION`. File: public domain / CC0 | 388 | Would scan other people's hosts | No. Scanner, and CC0 is outside the copy set |
| 5 | fedspendingtransparency | GovCon | [usaspending-api](https://github.com/fedspendingtransparency/usaspending-api) | CC0-1.0 | 477 | Award data for a GovCon desk | No. CC0 is outside the copy set, and the tree is an application |
| 6 | ngageoint | Military / GEOINT | [mrgeo](https://github.com/ngageoint/mrgeo) | Apache-2.0 | 210 | Raster mosaic for a map desk | No. Large Java service |
| 7 | PX4 | Military / drone | [PX4-Autopilot](https://github.com/PX4/PX4-Autopilot) | BSD-3-Clause | 13008 | Flight stack reference for Flower / POLLEN | No. Flight controller, hundreds of megabytes. Not a library these apps compile |
| 8 | Auterion | Defense drone | [px4-ros2-interface-lib](https://github.com/Auterion/px4-ros2-interface-lib) | BSD-3-Clause | 189 | Vehicle interface | No. It is a flight interface. Flower does not command aircraft firmware |
| 9 | WireGuard | Software / VPN | [wireguard-tools](https://github.com/WireGuard/wireguard-tools) | GPL-2.0 | 741 | VEIL VPN reference | No. GPL |
| 10 | mapbox | Drone / geo | [cheap-ruler](https://github.com/mapbox/cheap-ruler) | ISC | 434 | Fast distance and bearing for Flower | **Yes.** `flower-pollen` |
| 11 | bluenviron | Drone video | [mediamtx](https://github.com/bluenviron/mediamtx) | MIT | 20665 | Station video relay | No. Whole media server |
| 12 | dronekit | Drone | [dronekit-python](https://github.com/dronekit/dronekit-python) | Apache-2.0 | 1955 | Would arm and fly a vehicle | **Rejected for fit.** Flower and the drone backend do not command vehicles |
| 13 | ArduPilot | Drone | [ardupilot](https://github.com/ArduPilot/ardupilot) | GPL-3.0 | 16345 | Autopilot reference | No. GPL |
| 14 | betaflight | Drone | [betaflight](https://github.com/betaflight/betaflight) | GPL-3.0 | 11775 | Flight-controller reference | No. GPL |
| 15 | growthbook | Marketing experiments | [growthbook](https://github.com/growthbook/growthbook) | API `NOASSERTION`. File: MIT outside three Enterprise directories | 8583 | PRPGND subject-line assignment | **Yes.** SDK only, `prpgnd` |
| 16 | segmentio | Marketing | [analytics-node](https://github.com/segmentio/analytics-node) | MIT | 587 | Event collection | No. The client sends data to Segment |
| 17 | HubSpot | Marketing | [hubspot-api-nodejs](https://github.com/HubSpot/hubspot-api-nodejs) | Apache-2.0 | 402 | CRM calls | No. Paid API client |
| 18 | klaviyo | Marketing | [klaviyo-api-python](https://github.com/klaviyo/klaviyo-api-python) | MIT | 51 | Campaign sends | No. Paid API client |
| 19 | spotify | Algorithmic marketing | [annoy](https://github.com/spotify/annoy) | Apache-2.0 | 14337 | Nearest-neighbour recall | No. Native C++ index, not a fit for these TypeScript apps |
| 20 | linkedin | Algorithmic marketing | [luminol](https://github.com/linkedin/luminol) | Apache-2.0 | 1233 | Time-series anomaly scores | No. Python research library, no caller in these products |
| 21 | explosion | Algorithmic marketing | [spaCy](https://github.com/explosion/spaCy) | MIT | 34044 | Text for campaign copy | No. Model stack is large |
| 22 | optimizely | Algorithmic marketing | [javascript-sdk](https://github.com/optimizely/javascript-sdk) | Apache-2.0 | 81 | Experiment assignment | No. GrowthBook's local SDK was the smaller fit |
| 23 | mastodon | Social | [mastodon](https://github.com/mastodon/mastodon) | AGPL-3.0 | 50550 | Fabric-style social server | No. AGPL |
| 24 | matrix-org | Social | [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) | Apache-2.0 | 2199 | Fabric already speaks Matrix | No. The SDK is already the upstream Fabric uses. Not copied again |
| 25 | slackapi | Social | [node-slack-sdk](https://github.com/slackapi/node-slack-sdk) | MIT | 3377 | Workspace chat | No. Calls Slack |
| 26 | LemmyNet | Social | [lemmy](https://github.com/LemmyNet/lemmy) | AGPL-3.0 | 14675 | Federated forums | No. AGPL |
| 27 | sherlock-project | OSINT | [sherlock](https://github.com/sherlock-project/sherlock) | MIT | 109916 | Username search across sites | **Rejected.** It looks people up. Not imported |
| 28 | VirusTotal | Intelligence | [yara](https://github.com/VirusTotal/yara) | BSD-3-Clause | 10027 | Malware pattern matching for mail | No. C engine, not vendored into the mail app |
| 29 | oasis-open | Intelligence | [cti-python-stix2](https://github.com/oasis-open/cti-python-stix2) | BSD-3-Clause | 441 | STIX objects for ARGUS | No. Library is a platform dependency, not a small adapter |
| 30 | MISP | Intelligence | [misp](https://github.com/MISP/misp) | AGPL-3.0 | 6659 | Threat-intel sharing | No. AGPL |
| 31 | rapid7 | Intelligence | [metasploit-framework](https://github.com/rapid7/metasploit-framework) | API `NOASSERTION`. File: BSD-3-clause | 39521 | Exploit framework | **Rejected.** Offensive tooling. Not imported |
| 32 | pandas-dev | Data science | [pandas](https://github.com/pandas-dev/pandas) | BSD-3-Clause | 50478 | Tables for Cumulus exchange | No. Too large to vendor |
| 33 | scikit-learn | Data science | [scikit-learn](https://github.com/scikit-learn/scikit-learn) | BSD-3-Clause | 68142 | Classical models | No. Native stack |
| 34 | duckdb | Data science | [duckdb](https://github.com/duckdb/duckdb) | MIT | 42998 | Local analytics | No. Embedded database, not added as a new service |
| 35 | dbt-labs | Data science | [dbt-core](https://github.com/dbt-labs/dbt-core) | Apache-2.0 | 14146 | Transform projects | No. Whole toolchain |
| 36 | great-expectations | Data science | [great_expectations](https://github.com/great-expectations/great_expectations) | Apache-2.0 | 11925 | Data checks for the exchange | No. Application-sized |
| 37 | justadudewhohacks | Face | [face-api.js](https://github.com/justadudewhohacks/face-api.js) | MIT | 17993 | Descriptor distance for ei·det·ic | **Yes.** One file, `eidetic`. No model weights |
| 38 | opencv | Face | [opencv](https://github.com/opencv/opencv) | Apache-2.0 | 91531 | Detection runtime | No. ei·det·ic already has an OpenCV zoo seam and does not vendor the library |
| 39 | serengil | Face | [deepface](https://github.com/serengil/deepface) | MIT | 23678 | Face verification | No. TensorFlow stack and model downloads |
| 40 | deepinsight | Face | [insightface](https://github.com/deepinsight/insightface) | API returned no license. No LICENSE file in the repo root | 30205 | Recognition models | No. Unlicensed root, and the weights are often non-commercial. ei·det·ic already refuses them unless a separate license flag is set |
| 41 | iperov | Face | [DeepFaceLab](https://github.com/iperov/DeepFaceLab) | GPL-3.0 | 19275 | Face replacement | **Rejected.** GPL, and it is a face-swap tool |
| 42 | allenai | AI | [OLMo](https://github.com/allenai/OLMo) | Apache-2.0 | 6733 | Open training code | No. Training stack, not an app library |
| 43 | EleutherAI | AI | [lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) | MIT | 14456 | Model evals for SCALVS / Conjure | No. Harness is a research runner |
| 44 | langchain-ai | AI | [langchain](https://github.com/langchain-ai/langchain) | MIT | 149362 | Agent chains | No. Would replace the existing agent loop |
| 45 | cohere-ai | AI | [cohere-python](https://github.com/cohere-ai/cohere-python) | MIT | 410 | Hosted models | No. Paid API. Not wired |
| 46 | keycloak | Software / identity | [keycloak](https://github.com/keycloak/keycloak) | Apache-2.0 | 37821 | Optional IdP beside Cumulus ID | No. ei·det·ic already has an optional Keycloak verifier. The server was not copied |
| 47 | stanfordnlp | AI | [dspy](https://github.com/stanfordnlp/dspy) | MIT | 39012 | Prompt programs | No. Would replace Zerkalo's own schemas |
| 48 | NousResearch | AI | [Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) | MIT | 1498 | Tool-call checks for Zerkalo | **Yes.** `zerkalo` |
| 49 | google-deepmind | AI | [gemma](https://github.com/google-deepmind/gemma) | Apache-2.0 on this repository's code | 5841 | Model code | No. Weights ship under the Gemma terms, not Apache. Not copied |
| 50 | tailscale | Software / VPN | [tailscale](https://github.com/tailscale/tailscale) | BSD-3-Clause | 38934 | VEIL coordination reference | No. The client is a whole mesh VPN |

## Also checked and left out of the 50

These were verified on the same day and rejected before the list was closed. They are not a second survey.

- **iNavFlight/inav** and **paparazzi/paparazzi** are GPL flight stacks.
- **minio/minio**, **mastodon** (already in the 50), **zitadel/zitadel**, and **TheHive-Project/TheHive** are AGPL.
- **smicallef/spiderfoot** (MIT) and **laramies/theHarvester** (GPL-2.0) search people or harvest addresses. Not imported.
- **InQuest/python-iocextract** is GPL-2.0.
- **facefusion/facefusion** had no SPDX id on the API. It is a face-swap project. Not imported.
- **CMU-Perceptual-Computing-Lab/openpose** had no SPDX id. Not copied.
- **CompVis/stable-diffusion** had no SPDX id (the weights use a research license). Not copied.
- **cockroachdb/cockroach** is source-available (Business Source License on current releases). Not copied.

## Tests

Run on this machine with the new code left on (the off switches were covered by extra tests).

| Repo | Result |
|---|---|
| `flower-pollen` | `npm test` 35 passed. `npm run typecheck` passed. Node is v22.23.4; the repo asks for Node ≥ 24, so npm printed `EBADENGINE`. SQLite here is the Node 22 experimental build. |
| `eidetic` | `pnpm test` 51 passed, 1 skipped. `pnpm typecheck` passed. |
| `zerkalo` | `python3 -m pytest` 16 passed. |
| `prpgnd` | `tsc --noEmit` passed. The unit tests that do not need `.grok/skills` passed, including the two GrowthBook tests. `npm test` fails first: 4 script tests look for `.grok/skills/og/SKILL.md` and `.grok/skills/og/references`, which `.gitignore` excludes (`.grok/**`). Those 4 failures are on a fresh clone and are not caused by this change. |
| `infinitum-nexus` | This change is the survey file only. The monorepo suite was not run. |
