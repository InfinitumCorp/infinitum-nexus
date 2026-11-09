# SCALVS.ai Next Steps

The public hostname is `https://scalvs.app`. That name is hosted on Cloudflare. This document records the origin. It does not change DNS, Cloudflare, or a deployment.

`SCALVS_ORIGIN` overrides the advertised origin. Spectre's `SCALVS_URL` and VEIL's stored `origins.scalvs` can point at another http(s) process.

- Production integration with Architect evidence
- Context Vault persistence
- Tool registry expansion
- Team orchestration
- Firmament vault anchoring

See root PRODUCT-DELIVERY.md for status.

## Social sign-in
Available to every product via `socialFromEnv()` from `@infinitum/cid`. Set the standard GOOGLE_*/GITHUB_*/CHATGPT_* env vars.
