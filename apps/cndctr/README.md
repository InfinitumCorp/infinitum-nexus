# CNDCTR

Conductor, the former Architect product, by Infinitum Corporation®. This is the standalone server and web UI. It reuses `@infinitum/architect` to plan a score, perform it, and record the result. VEIL Ask posts `{ "intent", "autonomy": "rehearsal" }` to `/api/perform`.

The intended public origin is `https://cndctr.app`. This package does not deploy, change DNS, or spend anything.

## Run locally

```bash
pnpm install
pnpm --filter @infinitum/cndctr dev
```

Open `http://127.0.0.1:3011`. `/health` is public. Sign-in and `/api/perform` require a Cumulus ID token.

Production build:

```bash
pnpm --filter @infinitum/cndctr build
pnpm --filter @infinitum/cndctr start
```

Docker:

```bash
docker build -f apps/cndctr/Dockerfile -t cndctr .
docker run --rm -p 3011:3011 -e CNDCTR_PUBLIC_ORIGIN=http://127.0.0.1:3011 cndctr
```

## Cumulus ID

| Variable | Default |
| --- | --- |
| `CNDCTR_JWT_ISSUER` | `https://id.cumuluscloud.app/realms/cumulus` |
| `CNDCTR_OIDC_CLIENT_ID` | `cndctr` (the token audience) |
| `CNDCTR_JWKS_URI` | `{issuer}/protocol/openid-connect/certs` |
| `CNDCTR_PUBLIC_ORIGIN` | loopback, or `https://cndctr.app` in production |
| `CNDCTR_BIND` | `127.0.0.1` (`0.0.0.0` in the image) |
| `PORT` | `3011` |

Register public client `cndctr` at Cumulus ID. The redirect URI is `{origin}/api/auth/callback`.

Browser sessions stay in memory. API clients, including VEIL, send `Authorization: Bearer` with a Cumulus ID JWT whose `aud` or `azp` is `cndctr`.

```bash
curl -X POST http://127.0.0.1:3011/api/perform \
  -H "authorization: Bearer $CNDCTR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"intent":"Summarize the launch","autonomy":"rehearsal"}'
```
