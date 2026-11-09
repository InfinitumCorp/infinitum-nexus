# FABRIC++ server

Encrypted messaging for Cumulus ID. The web client signs in, opens a conversation, and sends a message. Message bodies and session keys are AES-256-GCM ciphertext in a local SQLite database.

This is encryption at rest on the server. The browser receives plaintext over the signed-in session. It does not hold the session key.

## Run

From the repository root, with Node.js 22.18 or newer:

```sh
pnpm install
pnpm --filter @infinitum/fabric-server start
```

Open the origin printed in the log. The default listen port is 3020. For a local process that is `http://127.0.0.1:3020`.

Sign-in redirects to Cumulus ID (Keycloak). Register a public client named `fabric` with the redirect URI `{FABRIC_PUBLIC_ORIGIN}/api/auth/callback`.

## Configuration

| Variable | Default | Use |
|---|---|---|
| `FABRIC_JWT_ISSUER` | `https://id.cumuluscloud.app/realms/cumulus` | Accepted token issuer. `CUMULUS_ID_HOST` and `CUMULUS_KEYCLOAK_REALM` are used when the issuer is unset. |
| `FABRIC_JWKS_URI` | `{issuer}/protocol/openid-connect/certs` | Signing keys. Must be on the issuer origin. |
| `FABRIC_OIDC_CLIENT_ID` | `fabric` | Required `aud` or `azp` on the JWT. |
| `FABRIC_OIDC_CLIENT_SECRET` | unset | Sent on the token request when the client is confidential. |
| `FABRIC_PUBLIC_ORIGIN` | `http://127.0.0.1:{port}` | Exact browser origin. Set this to the public `https` origin before exposing the process. |
| `FABRIC_ROOT_DOMAIN` | `infinitumfabric.app` | Product hostname. Bare hostname only. |
| `FABRIC_DATA_DIR` | `./data` | SQLite file and generated master key. |
| `FABRIC_DATABASE_URL` | `{data dir}/fabric.sqlite` | SQLite file. `sqlite://` paths are accepted. |
| `FABRIC_MASTER_KEY` | generated into `master.key` | Base64-encoded 32-byte key that seals session keys. |
| `FABRIC_METRICS_TOKEN` | unset | When set, `GET /metrics` requires `Authorization: Bearer`. |
| `FABRIC_BIND` | `0.0.0.0` | Listen address. |
| `PORT` | `3020` | Listen port. `0` asks the OS for a port. |

JWT algorithms: RS256, ES256, and EdDSA. `none` and HMAC are rejected.

## HTTP

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | no |
| GET | `/metrics` | no, unless `FABRIC_METRICS_TOKEN` is set |
| GET | `/` | the web client |
| GET | `/api/auth/login` | redirects to Cumulus ID |
| GET | `/api/me` | session cookie or bearer JWT |
| GET, POST | `/api/sessions` | session cookie or bearer JWT |
| GET | `/api/sessions/:id/messages` | a participant |
| POST | `/api/sessions/:id/messages` | a participant, JSON `{ "text": "..." }` |

Cookie-authenticated writes require the `Origin` header to equal `FABRIC_PUBLIC_ORIGIN`.

## Persistence

SQLite, through Node's built-in `node:sqlite`. The database stores accounts, sessions, login cookies (hashed), and ciphertext. Restarting the process with the same data directory and master key keeps the conversations.

## Tests

```sh
pnpm --filter @infinitum/fabric test
pnpm --filter @infinitum/fabric-server test
```

The server test starts the process, signs in through a loopback Keycloak stand-in, and runs the client: login, open a conversation, send, receive, reject another account, then restart and read the same message. The plaintext is not in the database file.

## Container

Build from the repository root. This does not deploy or publish the image.

```sh
docker build -f apps/fabric/Dockerfile -t fabric .
docker run --rm -p 3020:3020 -e FABRIC_PUBLIC_ORIGIN=https://infinitumfabric.app -e FABRIC_MASTER_KEY="$(openssl rand -base64 32)" fabric
```

The process listens as uid 10001 and keeps the database in `/data`.
