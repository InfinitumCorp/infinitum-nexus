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

## Teams

`/team` is team chat for workspaces. People sign in with Cumulus ID; the sign-in screen also offers "Create a Cumulus ID", which returns them to Teams already signed in.

| Area | What it does |
|---|---|
| Workspaces | Create one, invite with a code, join, rename, reset the code. Roles: owner, admin, member, guest. Admins can remove people. |
| Channels | Public and private channels, topic and description, rename, archive and unarchive, browse, join, leave, add and remove people, star, mute. `#general` and `#random` are created with each workspace and everyone joins them. |
| Conversations | Direct messages, group conversations of up to 9 people, and notes to yourself. |
| Messages | Formatting (`*bold*`, `_italic_`, `~strike~`, `` `code` ``, code blocks, quotes, lists, links), edit, delete, threads with "also send to channel", emoji reactions, pins, channel bookmarks, file sharing up to 1 MB with image previews, and a shared canvas per channel. |
| Mentions | `@person`, `@channel`, `@everyone`, `@here` (people active now) and `@user-group`. Mentions of people outside the channel are reported back to the sender. |
| Staying on top | Unread and mention counts, the New line, mark as unread, All unreads, Activity (mentions, replies, reactions, reminders), Threads, Later (saved messages with reminders), drafts kept per channel, desktop notifications for mentions and direct messages. |
| Time | Scheduled messages, reminders (`/remind me to … in 10m`, `at 15:00`, `tomorrow`), statuses that clear themselves, away, and do-not-disturb. |
| Search | Messages, channels, people and files. Filters: `in:#channel`, `in:@person`, `from:@person`, `has:link`, `has:file`, `has:reaction`, `has:pin`, `is:thread`, `is:saved`, `before:`, `after:`, `during:`, `"exact phrase"`. |
| Slash commands | `/me /shrug /topic /purpose /rename /invite /kick /join /leave /archive /dm /remind /status /away /active /dnd /mute /unmute /who /help` |
| Live | Typing indicators, presence and instant updates over Server-Sent Events (`GET /api/team/events`). Events carry ids only, never message text. |

Each channel has its own AES-256-GCM key, sealed by the master key. Message bodies, files, canvases and scheduled messages are sealed with the channel key and bound to their message or file id; reminders are sealed with the master key. Workspace, channel and user-group names and channel topics are stored as plain text so people can browse them. Search decrypts in the server process and looks at the newest 5,000 matching messages.

Not included: voice and video calls (huddles), workflows, apps and integrations, and shared channels between workspaces.

All team routes are under `/api/team` and are listed in `src/team-http.ts`.

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
