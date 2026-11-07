# Cumulus://Cloud Drive

Cumulus://Cloud is the Infinitum Corporation® file store: Cumulus Exchange and Cumulus Drive are this one product. This package keeps the bytes on the local filesystem and the catalog in PostgreSQL. Sign-in is a Cumulus://ID session from `packages/cid`.

The public host is `https://cloud.cumuluscloud.app`. Cumulus://ID is `https://id.cumuluscloud.app` and Cumulus://Mail is `https://mail.cumuluscloud.app`. Mailboxes are `name@cumuluscloud.app`. The domain is on Cloudflare for DNS and HTTPS. Share links use `https://cloud.cumuluscloud.app/v1/s/<token>`. Browsers on the ID, Cloud, and Mail origins are allowed by CORS. Nothing in this package changes Cloudflare DNS.

The in-memory `CloudStore` is still the metadata map the Cumulus suite uses for quota notices. The Drive HTTP API below is the byte store.

## What runs today

- Local filesystem driver, on by default. Writes go to a temporary file in the same directory, are fsynced, and are renamed into place. Each object has a SHA-256 sidecar, checked before the metadata commit.
- PostgreSQL metadata for folders, files, versions, upload sessions, share links, and per-CID quotas. Migrations live in `migrations/` and run on server start.
- HTTP API for streaming upload, multipart resume, ranged download, list, rename and move, trash and purge, share links, and quota.
- Ownership comes from the Cumulus://ID bearer token. A CID in the JSON body is rejected when it does not match the session. Queries are scoped to that CID.
- Optional at-rest encryption. Each file gets its own key, wrapped by a master key. The process reads the master key from the environment variable named by `CUMULUS_CLOUD_KMS_KEY_NAME`. The name is configuration. The key bytes are not in source.
- Rate limits, SHA-256 checks, and content-type sniffing. HTML, SVG, and XML are downloaded as `application/octet-stream` with `nosniff` and an attachment disposition.

The S3-compatible `BlobStore` interface is in `src/drive/driver.ts`. `S3BlobStore` is a stub. `CUMULUS_CLOUD_DRIVER=s3` fails at startup. This build does not import the AWS SDK, does not read cloud credentials, and does not contact a paid object store. A later driver can implement the same interface with AWS SDK for JavaScript v3 (Apache-2.0), which also speaks MinIO and Cloudflare R2. That dependency is not installed.

## Setup

PostgreSQL 16 is the database. It is free software you run yourself. From this directory:

```sh
docker compose up -d
```

Or install PostgreSQL from your operating system packages and create a database. The sample server does not start Docker for you.

```sh
export CUMULUS_CLOUD_DATABASE_URL=postgres://cumulus:cumulus@127.0.0.1:5432/cloud
export CUMULUS_CLOUD_DATA_DIR=/var/lib/cumulus-cloud
node --experimental-strip-types src/server.ts
```

The sample password above is for a database on your machine. Use a different password outside local development. The server listens on `127.0.0.1:3020`.

The sample server builds an in-memory Cumulus://ID so you can try the API. Sessions disappear when the process stops. A production host should pass the same `CidService` the rest of the account system uses. `createDriveApp` takes that service through `cidAuth`.

First request with a new session: `POST /v1/access` grants `drive:read` and `drive:write` on the `cumulus-cloud` app. Revoking those scopes in Cumulus://ID returns 403.

### Environment variables

| Name | Required | Default | Purpose |
|---|---|---|---|
| `CUMULUS_CLOUD_DATABASE_URL` | yes |  | PostgreSQL connection string |
| `CUMULUS_CLOUD_DATA_DIR` | no | `packages/cloud/data` | Directory for file bytes |
| `CUMULUS_CLOUD_DRIVER` | no | `local` | `local` only. `s3` is rejected |
| `CUMULUS_CLOUD_HOST` | no | `127.0.0.1` | Bind address |
| `CUMULUS_CLOUD_PORT` | no | `3020` | Bind port |
| `CUMULUS_CLOUD_MAX_UPLOAD_BYTES` | no | 5368709120 | Largest upload, 5 GiB |
| `CUMULUS_CLOUD_PART_BYTES` | no | 8388608 | Multipart part size, 8 MiB |
| `CUMULUS_CLOUD_CHUNK_BYTES` | no | 65536 | Encryption chunk size. Part size must be a multiple |
| `CUMULUS_CLOUD_RATE_LIMIT` | no | `120` | Requests per window, per IP and per CID |
| `CUMULUS_CLOUD_RATE_WINDOW_MS` | no | `60000` | Rate-limit window |
| `CUMULUS_CLOUD_KMS_KEY_NAME` | no | unset | Name of the env var that holds the 32-byte base64 master key. Unset means encryption is off |
| `CUMULUS_CLOUD_REQUIRE_INTEGRATION` | tests | unset | When `1`, the PostgreSQL tests fail instead of skipping if the database URL is missing |

No AWS, R2, or other paid storage variables are read.

### HTTP API

Bearer token: `Authorization: Bearer <Cumulus://ID session>`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/health` | Database ping. Reports `driver: local` |
| `POST` | `/v1/access` | Grants Drive scopes to the signed-in CID |
| `GET` | `/v1/quota` | Bytes used and the plan limit |
| `GET` | `/v1/list?folderId=` | Folders and files in one folder |
| `POST` | `/v1/folders` | `{ name, parentId }` |
| `PATCH` | `/v1/folders/:id` | Rename or move |
| `DELETE` | `/v1/folders/:id` | Trash. `?purge=1` deletes bytes |
| `POST` | `/v1/folders/:id/restore` | |
| `POST` | `/v1/files` | Raw body. `Content-Length`, `X-Cumulus-Name`, optional `X-Cumulus-Folder` and `X-Cumulus-Sha256` |
| `GET` | `/v1/files/:id` | Metadata |
| `GET` | `/v1/files/:id/content` | Download. `Range: bytes=` returns 206 |
| `POST` | `/v1/files/:id/content` | New version |
| `POST` | `/v1/files/:id/verify` | Re-hash plaintext and compare |
| `PATCH` | `/v1/files/:id` | Rename or move |
| `DELETE` | `/v1/files/:id` | Trash. `?purge=1` frees quota and deletes bytes |
| `POST` | `/v1/files/:id/restore` | |
| `GET` | `/v1/files/:id/versions` | |
| `DELETE` | `/v1/files/:id/versions/:versionId` | Older versions only |
| `POST` | `/v1/uploads` | `{ name, size, folderId?, fileId?, contentType?, sha256? }` |
| `PUT` | `/v1/uploads/:id/parts/:n` | Raw part. Parts may arrive out of order |
| `GET` | `/v1/uploads/:id` | Parts already stored, for resume |
| `POST` | `/v1/uploads/:id/complete` | |
| `DELETE` | `/v1/uploads/:id` | Abort and release the reserved quota |
| `POST` | `/v1/files/:id/shares` | `{ expiresAt? }`. The token is returned once |
| `GET` | `/v1/files/:id/shares` | No tokens |
| `DELETE` | `/v1/shares/:id` | Revoke |
| `GET` | `/v1/s/:token` | Public metadata |
| `GET` | `/v1/s/:token/content` | Public download until expiry or revocation |
| `GET` | `/v1/trash` | |
| `POST` | `/v1/trash/empty` | Purge trashed files and folders |

Trash still counts against quota. Purge releases it. The free plan is 15 GB (`FREE_ENTITLEMENTS.storageGb` in Cumulus://ID), using the same decimal gigabyte as the suite quota.

## Tests

Unit tests cover the filesystem driver, sniffing, encryption, the rate limit, and the disabled S3 stub. They do not need PostgreSQL.

Integration tests use the local filesystem and a PostgreSQL you already have. They are skipped unless `CUMULUS_CLOUD_DATABASE_URL` is set. CI sets `CUMULUS_CLOUD_REQUIRE_INTEGRATION=1` so a missing database fails the job.

```sh
pnpm --filter @infinitum/cloud test
pnpm --filter @infinitum/cloud typecheck
```

GitHub Actions workflow: `.github/workflows/cumulus-cloud-drive.yml`. It starts PostgreSQL 16 as a service container, runs these tests, and does not deploy.

## License table

Permissive dependencies only. Nothing from Nextcloud, Proton Mail WebClients, or proton-bridge is copied into this package.

| Component | How it is used | License |
|---|---|---|
| PostgreSQL | Metadata database, run by us or in CI. Not vendored | PostgreSQL License (permissive, BSD-style) |
| `pg` (node-postgres) | SQL client | MIT |
| Node.js `fs`, `http`, `crypto` | Files, API, SHA-256, AES-256-GCM | MIT |
| `@infinitum/cid`, `@infinitum/firmament` | Sessions and the audit ledger, in this repo | Infinitum Corporation® |
| AWS SDK for JavaScript v3 | Not installed. Reserved for a future S3-compatible driver | Apache-2.0, if added later |
| MinIO | Not used. Not a test dependency | Server is AGPL-3.0; it is not linked or copied |
| Nextcloud, Proton clients | Not used | GPL / AGPL / GPL-3.0-or-later; excluded |

## Launch gaps

- Where the disk and PostgreSQL run is undecided. This build does not provision a host, a volume, or a paid bucket.
- Backups and restore drills are not implemented. A useful backup is the data directory plus a PostgreSQL dump taken together.
- There is no monitoring, alerting, or request metrics.
- The rate limit and the upload-expiry timer are inside one process. A second host would not share them.
- The filesystem driver is one machine. It does not replicate.
- A crash after the blob is renamed and before the database commit can leave an unreferenced file. There is no garbage collector for those yet.
- The sample server's Cumulus://ID sessions are in memory.
- Encryption is off unless the master-key env name is set. There is no external KMS, rotation, or envelope-key audit.
- Share links with no expiry last until someone revokes them.
- Malware scanning is not included.
