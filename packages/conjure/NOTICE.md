# CONJURE provenance notice

Infinitum Corporation® CONJURE wrapper, state-machine, forecaster and brand-preset adaptations originate in the company-owned `InfinitumCorp/infinitum-corporation-site` repository, `scalvs-forecasts`, commit `860e1664276f9a14fcff89ade1907dd8a3154b87`:

- `scalvs/api/_conjure.js` → `src/engine.ts` (HTTP orchestration/state machine, hardened for backend use).
- `scalvs/src/forecaster.js` → `src/forecaster.ts` (explicit workflow transport; no browser-owned job state, local demo or automatic polling).
- `scalvs/src/data.js` → `src/product-presets.ts` (implemented product brands; technical questions adapted, not original persona/public-opinion prompts).

The source wrapper identifies the remote [MiroFish engine](https://github.com/666ghj/MiroFish) as AGPL-3.0. No MiroFish implementation source, GPL drone source, proprietary SDK, ZERKALO or ARGUS predictor was copied into this integration. The runtime engine remains a separately operated HTTP service with its own license and provider terms. Operators must independently review and satisfy those obligations; do not interpret this notice or service separation as an exemption from AGPL obligations.

Existing Nexus package code remains under its existing repository terms. No new external runtime dependency or upstream Apache code was added by this change. Synthetic test responses are fixtures, never production forecasts.
