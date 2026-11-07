# Labyrinth workspace build

Labyrinth *LBRNTH™ now has a runnable repository workspace at `/labyrinth` in
both +SPCTR and Cumulus://Mail. It uses the host's real Cumulus://ID cookie and
existing private organization storage. It has no separate login or public repository
mode. Open it from either product's navigation after signing in.

## Delivered

- Create and browse private repositories; select a product namespace, branch and
  retained version; read, edit, commit, delete and download artifacts.
- Import text and binary files up to 1 MiB through the browser. Binary artifacts
  remain bytes, never executable previews. Larger server-SDK limits are unchanged;
  HTTP requests remain capped at 2 MiB including JSON/base64 overhead.
- Create branches from a selected version and immutable tags. Browse paginated
  version history and file-level hash diffs. Every write compares the expected
  branch head; a conflict preserves the browser's editor text.
- Explicit permission grants and entitled-organization provisioning, with reader,
  writer, admin and owner membership management. CID directory membership,
  live plan/scopes/session checks and last-owner protection remain authoritative.
- Admin audit browsing in bounded pages. The audit stays hash-chained and
  encrypted; it is not an externally anchored ledger.
- Authenticated HTTP/client operations for session information, branches, tags,
  membership, audit, file deletion, binary transport and atomic multi-file commits.
- Offline verify, encrypted backup and key rotation commands. They acquire the
  writer lock, validate integrity, publish a new file without overwriting an existing
  destination, and keep the original snapshot intact.

The browser uses same-origin, no-store requests. It stores no credential in
localStorage, URLs or public configuration, renders repository text through DOM text
nodes/textarea, and clears cached private panels on a changed CID organization.
The shell and its assets carry noindex, no-store, frame denial and a strict CSP.
No motion is used. Desktop and 390px mobile layouts are supported.

## Run

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm security:labyrinth
pnpm pack:labyrinth
```

Configure the existing host as described in [run/deploy](LBRNTH-RUN-DEPLOY.md):
use a secret-manager supplied `LBRNTH_MASTER_KEY`, an explicit
`LBRNTH_ENTITLED_ORGS` and durable private host storage. Then start either:

```sh
# +SPCTR (default port 3000)
node --experimental-strip-types apps/spectre/src/server/main.ts
# Cumulus Mail (default port 3010)
node --experimental-strip-types apps/cumulus-mail/src/server.ts
```

Visit `/labyrinth` on that host. Existing Cumulus://ID sign-in and trusted
organization onboarding are prerequisites. In “First-time organization setup,”
choose the scopes to grant. An entitled CID organization admin can provision the
workspace. Permission consent does not purchase or activate a plan. When storage
is unconfigured the API returns 503, and a missing/expired CID session returns 401.

## HTTP/client additions

All commands are `POST /api/labyrinth`, with JSON, `x-labyrinth: 1`, a canonical
`product` and either the host's CID cookie or an explicit CID/repository bearer.
No requested CID, organization or role claim can replace authentication.

The browser-safe `createLabyrinthClient(product, options)` additionally exposes:

| Method | Behavior |
|---|---|
| `session()` | Current verified CID, organization, consent scopes and delegated flag; no credential bytes |
| `createBranch(repo, name, from)` | Fork at a retained commit or start empty with null |
| `createTag(repo, name, commit)` | Immutable reference |
| `members()`, `setMember(cid, roleOrNull)` | Existing-org repository roles; null revokes |
| `audit(after?, limit?)` | Sequence-based pages; max 1000, default page size 100 when paging is requested |
| `remove(repo, path, expectedHead, message?, branch?)` | Namespaced deletion in a new commit |
| `saveArtifact(repo, path, artifact, expectedHead, message?, branch?)` | `{content, encoding: "utf-8" | "base64"}` |
| `loadArtifact(repo, commit, path)` | Canonical base64, preserving binary bytes |
| `commit(repo, changes, expectedHead, message, branch?)` | Atomic batch; values are text, encoded artifacts, or null deletions |
| `history(repo, branch?, limit?, before?)` | `before` must be a commit on that branch; returns its ancestors, excluding the cursor |

Existing `save`, `load`, `history`, `diff`, consent and delegated credentials remain
compatible. Existing unpaged `audit()` is retained for server/SDK compatibility;
new browser requests explicitly use bounded pages. Product batch paths are prefixed
by the server, and traversal or malformed content rejects the whole transaction.

## Offline operations

Stop the host before maintenance. Supply the current key through the environment;
keys are never command-line arguments or printed in the command output.

```sh
pnpm labyrinth:maintain verify /private/labyrinth.json
pnpm labyrinth:maintain backup /private/labyrinth.json /private/backups/new-backup.json
# Also supply a distinct LBRNTH_NEXT_MASTER_KEY from your secret manager:
pnpm labyrinth:maintain rotate /private/labyrinth.json /private/labyrinth-next.json
```

The destination must be new. Verification checks object/commit hashes, references,
audit and capacity. A stale writer lock, wrong key or corrupted snapshot fails
closed. For rotation, keep a backup and the old key, configure the new key and new
snapshot path on the stopped host, then start exactly one writer and verify reads.
Rollback uses the original key and original snapshot; do not overwrite either.
A `.lock` left by a crash requires operator inspection, never automatic removal.

## Validation

Local verification used Node 24.22.1 and pnpm 10.28.0. CI retains its pinned Node
22.23.4 configuration. Full workspace tests and typecheck, dependency/license/secrets
checks and package generation are required before the PR is ready.

Chromium/Playwright checked the actual +SPCTR host with a passkey-created CID
session and encrypted storage: read/edit/commit, exact binary import/download,
branch/tag, diff, members, audit, anonymous denial, no page errors and no page
horizontal overflow at 390px. HTTP regression tests cover stale writes, immutable
tags, last-owner safety, cross-org assignment denial, malformed bearer refusal,
atomic text/binary batches, traversal rollback and bounded history/audit paging.
Maintenance tests cover backup restore, source preservation, wrong/new keys,
permissions, overwrite refusal, writer locks and tampered snapshots.

## Production boundary

This is a source build and local verification, not a production activation. Hosting
credentials, a real billing authority and organization allowlist were not supplied.
The existing encrypted file adapter still requires one long-lived writer with
persistent disk. It is not suitable for ephemeral serverless disks. Distributed
transactional storage, live billing/KMS, Git wire protocol, merges, firmware sync
and new implementations for registry-only products remain separate work. No
production domains, DNS, package registry or unrelated product code is changed.
