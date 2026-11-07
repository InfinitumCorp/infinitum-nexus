# Architect Deploy

The public hostname for CNDCTR is `https://cndctr.app`. That name is hosted on Cloudflare. This document records the origin. It does not change DNS, Cloudflare, or a deployment.

The process still listens on `PORT` (default 3001). `CNDCTR_ORIGIN` overrides the advertised origin. Clients reach a different process with `ARCHITECT_URL` or VEIL's stored `origins.architect`.

1. `pnpm --filter @infinitum/architect typecheck`
2. `pnpm --filter @infinitum/architect start` (or use Dockerfile / vercel.json)
3. Health endpoint available if wired.

See root DEPLOY.md for full checklist.

## Social sign-in
Available to every product via `socialFromEnv()` from `@infinitum/cid`. Set the standard GOOGLE_*/GITHUB_*/CHATGPT_* env vars.
