# Labyrinth *LBRNTH

Private client code and artifact repositories, built into Infinitum products.
By **Infinitum Corporation®**. Product id: **`LBRNTH`**; display name: **Labyrinth**.

This package is a server-side SDK shared by VEIL, ODIN and other product backends.
It is not an internal Infinitum source store, a public repository service, a Git
remote, or a standalone deployed web application. Client organizations own their
separate repository namespaces; no public visibility or anonymous reads exist.

## Integrate

```ts
import { Labyrinth, EncryptedFileStorage } from "@infinitum/lbrnth";

const labyrinth = new Labyrinth({
  can: cidService.can.bind(cidService),
  // These two authorities MUST be implemented by the trusted host, not the user.
  entitled: (org, product) => billing.hasProduct(org, product),
  canProvision: (actor, org) => directory.isOrganizationOwner(actor, org),
  storage: new EncryptedFileStorage("/private-data/lbrnth.json", org => keys.forOrg(org)),
});

// Provision once, from an authenticated organization's owner/admin workflow.
// CID requires explicit repo:read, repo:write, repo:admin consent for LBRNTH.
labyrinth.createOrganization(session.cid, session.orgId, "Client company");
const client = labyrinth.forClient(session.cid, session.orgId);
const repo = client.createRepository("application");
const commit = client.commit(repo.id, {
  branch: "main", expectedHead: null, message: "Initial version",
  changes: { "src/main.ts": "export const hello = 'world';" },
});
client.createBranch(repo.id, "feature/api", commit.id);
client.createTag(repo.id, "v1", commit.id);
const bytes = client.readFile(repo.id, commit.id, "src/main.ts");
const history = client.history(repo.id);
const changedFiles = client.diff(repo.id, null, commit.id);
```

`session`, `billing`, `directory` and `keys` above are host dependencies, not
implementations shipped by this package. Never accept CID identity, provisioning
permission, billing flags, or encryption keys from a request body. Derive identity
from the host's verified session and protect mutations against CSRF. Browser
products call their authenticated backend; do not bundle this SDK or keys into VEIL.

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
- `forClient(cid, orgId)` — identity-bound repo API above; still reauthorizes each
  call. Member/admin methods stay on the trusted server service.

Path names reject traversal, absolute paths, backslashes, control characters,
prototype keys and file/directory collisions. Returned values are defensive copies.
Hashes use bytes for objects and a stable sorted-tree representation for commits.
Audit entries record accepted reads, mutations and membership targets, not source
content. Failed requests throw `LabyrinthError` (`forbidden`, `not_found`,
`invalid`, `conflict`, `integrity`). Denied requests should also be logged by the
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

The file adapter supports **one process/writer**, not distributed transactions.
Run one service instance for a snapshot. It rewrites the snapshot synchronously;
large-scale production needs a database/object-store adapter with transactional
compare-and-swap and concurrency control. The storage interface's save contract
is atomic whole-snapshot replacement. No network endpoints are exposed by default.

Audit is hash chained, encrypted and append-only through the API, **not** an
externally anchored immutable ledger. A host with storage keys can replace or roll
back a complete snapshot; backups, external audit anchoring and key rotation are
operator responsibilities. Encryption is at rest, not end-to-end: the trusted
backend can decrypt. Never execute repository content as part of a read or commit.

## Follow-on product decisions (not silently assumed)

- Plan pricing/quotas and the live billing/directory authority in each product.
- Client repository UI, authenticated HTTP routes, deployment and Git wire protocol.
- Production database/object-store adapter, multi-instance writes, backups and KMS
  key rotation; repo ACLs/invites beyond org-wide roles.
- Line-level patches, merges, protected branches, large-artifact streaming,
  repository retention/deletion policies and external Firmament audit anchoring.

Run `pnpm --filter @infinitum/lbrnth test` and `pnpm typecheck` from the workspace.
