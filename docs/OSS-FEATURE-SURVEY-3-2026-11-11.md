# Open-source feature survey III — social platforms, 2026-11-11

The operator asked for social platforms, their data-collection code, and the algorithms they use for marketing. The same day's general survey is [OSS-INTEGRATION-SURVEY-3](OSS-INTEGRATION-SURVEY-3-2026-11-11.md) ([#132](https://github.com/InfinitumCorp/infinitum-nexus/pull/132)). It is not repeated here. Two standing rules: no product UI changes, and do not touch the websites. Nothing here collects a person's posts, location, or contacts.

## What landed

Nothing from this survey remains in the Infinitum repos.

## Fifty platforms

Usable means the license is MIT, Apache-2.0, or BSD and the code is a library, not a copyleft application. "Not published" means the production feed ranker is not in the public org.

| # | Platform | What is public | License | Use |
|---|---|---|---|---|
| 1 | X, current | For You value model, `xai-org/x-algorithm` | Apache-2.0 | Used. See above. |
| 2 | X, 2023 tree | `twitter/the-algorithm`, `the-algorithm-ml` | AGPL-3.0 | Not copied. |
| 3 | xAI prompts | `xai-org/grok-prompts` | AGPL-3.0 | Not copied. |
| 4 | Facebook / Instagram | `facebookresearch/dlrm` | MIT | Training model. Stays upstream. The production ranker is not this repo. |
| 5 | Meta forecasts | `meta/prophet` | MIT | Campaign time series. Stays upstream (large). |
| 6 | Meta experiments | `meta/Ax` | MIT | A/B design. Stays upstream. |
| 7 | Meta similarity | `facebookresearch/faiss` | MIT | Audience nearest-neighbor. About 300 MB. Not copied. |
| 8 | Meta ads lift | `facebookresearch/fbpcs` | MIT, archived | Private measurement. Not copied. |
| 9 | Meta ads API | `meta/facebook-python-business-sdk` | no SPDX | Not copied. Calls Meta; it is not our collector. |
| 10 | Threads | no separate ranker | — | Nothing to take. |
| 11 | TikTok / ByteDance | `bytedance/monolith` | no SPDX, archived | The recommendation system is not licensed for a copy. |
| 12 | ByteDance | `bytedance/fedlearner` | Apache-2.0 | Multi-party model training. Fits an opted-in exchange later. Not copied. |
| 13 | ByteDance | `bytedance/bitsail` | Apache-2.0, archived | Log shipping. Not copied. |
| 14 | ByteDance | `bytedance/deer-flow` | MIT | An agent harness, not the For You page. Not merged. |
| 15 | Snap | `Snapchat/KeyDB` | BSD-3-Clause | A database. The Snapchat ranker is not published. |
| 16 | LinkedIn | `linkedin/greykite` | BSD-2-Clause | Forecasts. Stays upstream. The feed ranker is not published. |
| 17 | LinkedIn | `feathr-ai/feathr` | Apache-2.0 | Feature store used for ads. Not copied. |
| 18 | LinkedIn | `datahub-project/datahub` | Apache-2.0 | Data catalog. Not a ranker. Not copied. |
| 19 | Pinterest | `pinterest/singer`, `pinterest/memq` | Apache-2.0 | Log shipping and a pub/sub. First-party collection pattern. Not wired into a site. |
| 20 | Pinterest | `pinterest/querybook` | Apache-2.0 | A query UI. Not applied. |
| 21 | Pinterest | `pinterest/secor` | Apache-2.0, archived | Kafka log persistence. Not copied. |
| 22 | Reddit | `reddit/baseplate.py` | BSD-3-Clause, archived | Service framework. The ranking formula is not published. |
| 23 | Bluesky | `bluesky-social/feed-generator` | MIT | Starter for a custom feed. Not a drop-in for Fabric. |
| 24 | Bluesky | `bluesky-social/atproto` | SPDX unset on the repo | Not copied until the file is identified. |
| 25 | YouTube | `tensorflow/recommenders` | Apache-2.0 | How to train a ranker. The production one is not published. |
| 26 | Discord | API docs, `discord/manifold` | CC-BY-SA docs, MIT code | No feed ranker. Docs are not code. |
| 27 | Telegram | `telegramdesktop/tdesktop` | GPL-3.0 | Not copied. Not a marketing ranker. |
| 28 | WhatsApp | nothing public | — | Nothing to take. |
| 29 | WeChat / Tencent | `Tencent/ncnn` | SPDX unset on the repo | Inference runtime, not the WeChat ranker. Not copied. |
| 30 | Weibo | no ranking repo found | — | Nothing to take. |
| 31 | Bilibili | no ranking repo in this pass | — | Nothing to take. |
| 32 | Kuaishou | no ranking repo in this pass | — | Nothing to take. |
| 33 | Xiaohongshu | no public org with a ranker | — | Nothing to take. |
| 34 | VK | `VKCOM/statshouse` | MPL-2.0 | Metrics, not a ranker. Not copied. |
| 35 | Kakao | `kakao/buffalo` | Apache-2.0 | Production recommendation library. Stays upstream. |
| 36 | LINE / Naver | no feed ranker in this pass | — | Armeria and the LINE SDK are not the ranking formula. |
| 37 | Tumblr | nothing relevant | — | Nothing to take. |
| 38 | Mastodon | `mastodon/mastodon` | AGPL-3.0 | Not copied. |
| 39 | Spotify | `spotify/annoy`, `spotify/voyager` | Apache-2.0 | Nearest-neighbor for an audience. Stay upstream. |
| 40 | Netflix | `Netflix/metaflow` | Apache-2.0 | ML pipelines. The recommender is not published. |
| 41 | Twitch | no feed ranker in this pass | — | Nothing to take. |
| 42 | Yandex Zen / CatBoost | `catboost/catboost` | Apache-2.0 | The boosting library ads teams train. Huge. Stays upstream. |
| 43 | Yahoo / Vespa | `vespa-engine/vespa` | Apache-2.0 | Serving a ranked feed. Huge. Stays upstream. |
| 44 | Meituan | `Meituan-Dianping/Logan` | MIT | Mobile diagnostic log. Not a feed ranker, and not added to the apps. |
| 45 | Meituan | `Meituan-Dianping/Leaf` | Apache-2.0 | Distributed ids. Not copied. |
| 46 | Baidu | `PaddlePaddle/PaddleRec` | Apache-2.0 | Classic rankers (Wide&Deep, DSSM, MIND). Training stack. Not copied. |
| 47 | Taobao / Alibaba | `alibaba/EasyRec`, `DeepRec-AI/DeepRec` | Apache-2.0 | Same. Not copied. |
| 48 | Criteo | `criteo/autofaiss` | Apache-2.0 | Builds a FAISS index. Not copied. |
| 49 | Microsoft | `recommenders-team/recommenders` | MIT | Best-practice recommenders. Not copied. |
| 50 | NVIDIA | `NVIDIA-Merlin/Merlin` | Apache-2.0 | GPU recommendation stack. Not copied. |

## Collection code that is not a ranker

These are how a product records opted-in events. None of them were added to a website or an app in this pass.

| Project | License | Why it stayed out |
|---|---|---|
| `snowplow/snowplow-javascript-tracker` | BSD-3-Clause | First-party event tracker. Wire it only on a surface that already asks. |
| `mixpanel/mixpanel-js` | Apache-2.0 | Sends events to Mixpanel. |
| `amplitude/Amplitude-TypeScript` | MIT | Sends events to Amplitude. |
| `segmentio/analytics.js` | MIT, archived | The old collector. Archived upstream. |
| `umami-software/umami` | MIT | A whole analytics product. Not a library to drop in. |
| `PostHog/posthog` | MIT outside `ee/` | The application is a product. The enterprise tree is separate. Not copied. |
| `growthbook/growthbook` | The application is a split license. The JavaScript SDK is MIT, and survey #132 uses that SDK in PRPGND. The enterprise directories were not used. This pass did not change PRPGND. |
| `rudderlabs/rudder-server` | Elastic-2.0 | Cannot be offered as a hosted service. Not copied. |
| `matomo-org/matomo` | GPL-3.0 | Not copied. |
| `prebid/Prebid.js` | Apache-2.0 | Header bidding. Not added to a page. |
| `Unleash/unleash` | AGPL-3.0 | Not copied. |
| `google/openrtb` | repo 404 | The OpenRTB spec is not that path. |

## What this does not do

- It does not scrape X, Instagram, TikTok, or any other platform.
- It does not treat a raw like count as the For You score. The published comments say that reading is wrong.
- It does not copy a copyleft feed, client, or analytics server into a proprietary app.
- Instagram, TikTok, Snapchat, Reddit, WeChat, and YouTube have not published the ranker that actually runs their feed.
