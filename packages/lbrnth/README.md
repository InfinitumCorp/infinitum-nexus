# Labyrinth *LBRNTH

Private client code and artifact repositories, built into Infinitum products.
By **Infinitum Corporation®**. Product id: **`LBRNTH`**; display name: **Labyrinth**.

This package is a server-side SDK shared by VEIL, ODIN and other product backends.
It is not an internal Infinitum source store, a public repository service, a Git
remote, or a standalone deployed web application. Client organizations own their
separate repository namespaces; no public visibility or anonymous reads exist.

A shared browser workspace is available at `/labyrinth` in +SPCTR and Cumulus Mail.
See [workspace build and operator guide](../../docs/LBRNTH-BUILD.md).

## Integrate

```ts
import { CidLabyrinth, EncryptedFileStorage } from "@infinitum/lbrnth";

const repositories = new CidLabyrinth(cidService, {
  entitled: (org, product) => billing.hasProduct(org, product),
  storage: new EncryptedFileStorage("/private-data/lbrnth.json", org => keys.forOrg(org)),
});
// A verified, opaque CID session from existing passkey/MFA/social/SSO sign-in.
// The SDK authenticates it again on every call; CID/org strings are not credentials.
await repositories.consent(sessionToken, ["repo:read", "repo:write", "repo:admin"]);
repositories.provision(sessionToken); // existing CID org admin only; still needs a paid plan
const client = repositories.forProduct(sessionToken, "veil");
const repo = client.createRepository("application");
const commit = client.save(repo.id, "src/main.ts", "export const hello = 'world';", null);
const bytes = client.load(repo.id, commit.id, "src/main.ts");
```

See [all-product integration/auth guide](../../docs/LBRNTH-INTEGRATIONS.md) for
HTTP clients, short-lived repository-only credentials and the full product matrix.

`sessionToken`, `billing` and `keys` above are host dependencies, not
implementations shipped by this package. Never accept CID identity, provisioning
permission, billing flags, or encryption keys from a request body. Derive identity
from the host's verified session and protect mutations against CSRF. Browser
products call their authenticated backend; do not bundle this SDK or keys into VEIL.

## Canonical domain

Cumulus://ID, Cumulus://Cloud and Cumulus://Mail share `cumuluscloud.app`
(Cloudflare). Hosts read it from the environment; these are the defaults:

| Variable | Default |
|---|---|
| `CUMULUS_ROOT_DOMAIN` | `cumuluscloud.app` (mail addresses are `name@cumuluscloud.app`) |
| `CUMULUS_ID_HOST` | `id.cumuluscloud.app` |
| `CUMULUS_KEYCLOAK_REALM` | `cumulus` |
| `CUMULUS_CLOUD_HOST` | `cloud.cumuluscloud.app` |
| `CUMULUS_MAIL_HOST` | `mail.cumuluscloud.app` |

`labyrinth.corsHeaders(requestOrigin)` allows only the exact HTTPS origins of
those three hosts. A wildcard origin is rejected, and `Access-Control-Allow-Origin`
is never `*`. Pass `corsOrigins` to narrow that list; every entry must be an
exact origin. The CID issuer is the Keycloak realm
`https://id.cumuluscloud.app/realms/cumulus`, derived from `CUMULUS_ID_HOST` and
`CUMULUS_KEYCLOAK_REALM`. Its keys are published at
`https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs`.

## Authorization and data model

Every operation checks **both** live client-org `LBRNTH` entitlement and CID's
existing `can(cid, "LBRNTH", scope)` consent, then organization membership. Consent
is not a purchase: granting yourself CID scopes never activates a paid plan.
LBRNTH is not added to free entitlements. Provisioning also checks the trusted
organization directory so knowing an org id cannot claim it.

Roles apply to all repositories **within one client org**:

| Role | Read files/history | Commit/branch/tag/create repo | Manage members/audit |
|---|---|---|---|
| reader | Yes | No | No |
| writer | Yes | Yes | No |
| admin | Yes | Yes | Yes, except owners |
| owner | Yes | Yes | Yes |

Only owners can appoint/demote owners; the last owner cannot be removed or demoted.
The CID-authenticated adapter also requires current CID directory-admin status for
member management/audit and for administrative role assignments.
Removing membership immediately denies access even to an already bound SDK.
There are no cross-org shares or per-repo ACL exceptions in this first version.
Repository lookup, commit lookup and object reads always stay within the authorized
org and repo. Objects are never exposed through a global hash-only endpoint.

## API surface

- `createOrganization(cid, orgId, name)` — provision a trusted, entitled client org.
- `members(cid, orgId)`, `setMember(cid, orgId, memberCid, role | null)` — list,
  assign roles, or revoke; assignment is a trusted admin action, not an invite.
- `repositories(cid, orgId)`, `createRepository(cid, orgId, name)` — private repo
  summaries including branches and tags; no content dump.
- `commit(cid, orgId, repoId, {branch, expectedHead, message, changes})` — immutable
  full-tree version with SHA-256 content objects; strings are UTF-8, bytes preserve
  binary artifacts, null deletes a path. Mandatory head compare-and-swap rejects
  stale writers. Max 1000 changed paths and 10 MiB changed content per commit.
- `createBranch(..., name, commitId | null)`, `createTag(..., name, commitId)` —
  branches can start empty or fork an existing commit; tags cannot be overwritten.
- `history(..., branch?, limit?)` — newest first, along parent chain, max 1000.
- `readFile(..., commitId, path)` — bytes from any retained historical version.
- `diff(..., fromCommitId | null, toCommitId)` — sorted file-level additions,
  modifications and deletions with before/after hashes (not a line-level patch).
- `audit(cid, orgId)` — admin-only audit entries, excluding the audit read itself
  until the next call; `verifyAudit(entries)` validates the hash chain.
- `forClient(cid, orgId)` — **deprecated server-internal** identity-bound repo API;
  external callers must use `CidLabyrinth.forSession(token)` or `forProduct(token, product)`. It still reauthorizes each
  call. Member/admin methods stay on the trusted server service.
- `CidLabyrinth.consent(token, scopes)` records explicit CID consent, not payment.
- `CidLabyrinth.issueToken(token)` creates a 15-minute repository-only bearer,
  hash-stored and linked to the live parent CID session. It cannot authenticate
  to CID itself, grant consent, renew credentials or outlive parent revocation.

Path names reject traversal, absolute paths, backslashes, control characters,
prototype keys and file/directory collisions. Returned values are defensive copies.
Hashes use bytes for objects and a stable sorted-tree representation for commits.
Audit entries record accepted reads, mutations and membership targets, not source
content. Failed requests throw `LabyrinthError` (`forbidden`, `not_found`,
`invalid`, `conflict`, `integrity`, `capacity`). Denied requests should also be logged by the
host's security logger; they do not mutate another client's audit history.

## Persistence and security boundaries

Default `MemoryStorage` is ephemeral, for tests/local development only. Production
hosts must configure durable storage. `EncryptedFileStorage` seals the **entire
org payload**, including source, artifact bytes, commit metadata, team and audit,
with AES-256-GCM and a fresh 96-bit nonce. AAD binds envelope version and org id.
Only org ids and ciphertext envelope sizes remain visible in the snapshot manifest.
Supply a different 32-byte key per client from a trusted secret manager. Keys are
never serialized. Wrong keys and tampering fail closed. Do not print or commit keys.

Snapshot replacement writes a 0600 temporary file, flushes it, then atomically
renames it. The service publishes memory only after a successful save. Content,
commit, reference and audit integrity are checked on restore. The backing directory
must be private and writable only by the host service; avoid shared writable paths.

The file adapter is designed for **one active service/writer**, not distributed transactions.
An exclusive lock plus whole-file revision compare-and-swap rejects concurrent/stale
writers instead of silently overwriting them. After a stale-writer conflict, recreate
the service from storage before retrying the authenticated request. A crashed writer
can leave a `.lock` file: verify that no writer is running before an operator removes
it; there is deliberately no automatic stale-lock bypass. Cleanup failure after a
committed rename does not report a false rollback; a retained lock blocks later saves.
It rewrites the snapshot synchronously;
large-scale production needs a database/object-store adapter with transactional
compare-and-swap and concurrency control. The storage interface's save contract
is atomic whole-snapshot replacement; custom shared adapters also need stale-writer
protection. No network endpoints are exposed by default.

## Capacity and abusive requests

Content bytes are measured **before** allocating buffers or cloning the client's
snapshot. Malformed change maps, invalid member identifiers and overlarge payloads
fail without writes. Hard ceilings bound retained resource growth: 256 organizations,
100 repositories and 1000 members per org, 10000 commits per repository, 1000 total
branch/tag refs per repository, 10000 paths per tree and 50000 audit entries per org.
Unencrypted org snapshots are limited to 32 MiB each and 128 MiB total; the encrypted
file is capped at 192 MiB before reading/parsing. Capacity violations reject the whole
transaction, including its audit entry. Existing oversized snapshots fail closed on
startup, not silently truncated. Configure `limits` only to **lower** these ceilings.

Each org has a 240-operation/minute budget before snapshot cloning, shared across
its members but separate from other clients. It resets after one minute and on
service restart; this is a local guard, not a distributed billing/rate-limit service.
Audit/storage capacity requires operator archival/migration policy before it fills;
this package never silently drops audit history. Hosts still need HTTP body limits,
edge rate limiting and pagination/streaming for scale. No hostile tenant should be
co-hosted in the same synchronous process without those deployment controls.

Authorization/provision callbacks are synchronous and must return literal `true`.
A Promise, object or other truthy non-boolean value is denied (including accidentally
passing an async billing adapter). Resolve/certify authorization in the trusted host
before invoking the SDK; never convert an unresolved Promise to a Boolean.

Audit is hash chained, encrypted and append-only through the API, **not** an
externally anchored immutable ledger. A host with storage keys can replace or roll
back a complete snapshot; backups, external audit anchoring and key rotation are
operator responsibilities. Encryption is at rest, not end-to-end: the trusted
backend can decrypt. Never execute repository content as part of a read or commit.

## Follow-on product decisions (not silently assumed)

- Plan pricing/quotas and the live billing/directory authority in each product.
- Production deployment and Git wire protocol. The shared repository UI and authenticated HTTP routes are implemented; see the workspace guide.
- Production database/object-store adapter, multi-instance writes, backups and KMS
  key rotation; repo ACLs/invites beyond org-wide roles.
- Line-level patches, merges, protected branches, large-artifact streaming,
  repository retention/deletion policies and external Firmament audit anchoring.

Run `pnpm --filter @infinitum/lbrnth test` and `pnpm typecheck` from the workspace.
