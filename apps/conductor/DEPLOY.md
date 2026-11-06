# Architect Deploy

1. `pnpm --filter @infinitum/conductor typecheck`
2. `pnpm --filter @infinitum/conductor start` (or use Dockerfile / vercel.json)
3. Health endpoint available if wired.

See root DEPLOY.md for full checklist.

## Social sign-in
Available to every product via `socialFromEnv()` from `@infinitum/cid`. Set the standard GOOGLE_*/GITHUB_*/CHATGPT_* env vars.
