# Labyrinth adversarial security/code review

Review date: 2026-11-07 (Europe/Moscow). Original PR #25 baseline: `eefad49`.
Security fixes: `ba66d63`. Scope: `packages/lbrnth`, CID registration and integration
contract. This is a fresh adversarial second pass by the implementation agent plus
scanners, **not an independent external security audit** or production certification.

## Findings and fixes

### High — fail-open integration with async/truthy authority callbacks (fixed)

`!entitled(...)`, `!can(...)` and `!canProvision(...)` treated any truthy object,
including an unresolved `Promise<false>`, as approval. Correctly typed synchronous
CID callers were unaffected, but a JavaScript host accidentally supplying an async
billing/directory adapter could bypass entitlement/provisioning authorization.

Approval now requires literal boolean `true`. Promises and all other truthy values
are denied; rejected promises are consumed to prevent unhandled-rejection crashes.
Tests cover all three authorities with promises, objects, strings and numbers,
and rejected async authorities. No remote caller can supply these callbacks; this
is a fail-closed protection against host-integration mistakes.

### High — unbounded retained-state and allocation-driven availability risk (fixed)

The 10 MiB commit limit was checked after `Buffer.from`, and aggregate retained
objects, versions, refs, members and read-generated audit had no ceilings. A valid
client could repeatedly write or read to grow a shared process's resources.

Preflight now occurs **after authorization** but before snapshot cloning/content
allocation. It validates runtime change maps and measures UTF-8/byte content before
buffer allocation. Hard ceilings bound per-org and total serialized state, counts
of organizations/repos/members/commits/refs/tree paths/audit records, and encrypted
file size before read/parse. Configurable limits can only lower hard ceilings.
A separate local per-org operation budget limits repeated snapshot rewrites.
Transactions exceeding quotas do not persist objects, versions or audit events.

Tests cover malformed/oversized input, count/byte quotas, rollback, client-isolated
rate budgets/reset, and denial before inspecting an unauthorized payload.

### Medium — stale service snapshot can overwrite committed state (fixed)

Branch-head CAS worked inside one service, but two accidentally active instances
could both compare against stale in-memory heads and replace the same file. The
old adapter documented single-writer usage, but did not enforce it.

Exclusive lock creation serializes cooperating file writers across processes. A
whole-file SHA-256 revision comparison rejects stale state before rename. A service
must be recreated from storage before retrying after conflict. A crash-left lock
fails closed and requires operator verification; there is no automatic lock bypass.
Cleanup errors after a successful rename do not produce a false rollback result.
Tests reproduce stale overwrite on the baseline and verify rejection plus lock
contention without modifying the winner's persisted state.

### Low — malformed runtime values produced incidental TypeErrors (fixed)

Organization names, member identifiers and change-map shape now have explicit
runtime guards returning the SDK's validation errors. TypeScript types alone are
not treated as input validation.

## Reviewed boundaries with no additional exploitable finding

- **Tenant isolation:** every object/commit/repo lookup is nested inside an
  authorized org; no global hash-only read API. Membership, live entitlement and
  CID consent are checked for every call; revocation affects bound SDK handles.
- **Roles/identity:** owner/admin checks prevent owner escalation and last-owner
  removal. `forClient` binds a server-verified CID/org but is not itself a login
  mechanism; exposing its factory or identity parameters directly to clients is
  prohibited by the host integration contract. Roles are intentionally org-wide.
- **Crypto:** Node AES-256-GCM, fresh cryptographic 12-byte nonce per org envelope
  per write, 16-byte tag verification and version/org AAD. Keys are caller-supplied
  32-byte per-org secrets, never derived from public org ids or serialized/logged.
  Host KMS/key separation/rotation remains mandatory operational configuration.
- **Integrity:** objects hash original bytes, commits hash stable sorted trees,
  references are checked on restore, audit hash chains cover defined event fields.
  Restore/tamper tests reject modified objects, commits, refs, audit and ciphertext.
- **Paths:** paths are logical names only; no client path is joined into a host
  filesystem path. Traversal, absolute paths, backslashes, prototype keys and
  file/directory collisions are rejected. Prototype-method filenames are handled
  with own-property checks in diff operations.
- **CAS:** mandatory expected-head comparison protects single-service version
  writes, and file revision CAS protects against stale multi-instance replacement.
- **Secrets/dependencies:** no source secrets found by targeted Semgrep secrets
  rules; dependency audit reported no advisories. Repository content is never run.

## Verification

- Full `pnpm test`: **411 passed, 0 failed**, across 24 test workspaces.
- LBRNTH package: **21 passed**, including seven new security regressions.
- Full `pnpm typecheck`: **24 workspaces passed**.
- Semgrep `p/security-audit` + `p/secrets`: **0 findings, 0 scan errors**, 11 targets.
- `pnpm audit --json`: **0 vulnerabilities** across 29 reported dependencies.
- `git diff --check`: clean.

No known unresolved high/critical code findings remain in this SDK scope. This
statement is not a guarantee of security and does not certify an unimplemented
hosting deployment.

## Residual deployment/design limitations

Audit is encrypted/hash-chained but not independently anchored: a privileged host
holding storage keys can roll back/replace an entire snapshot. No external audit
anchoring is implemented. At-rest encryption is not end-to-end encryption.
Snapshot count/size ceilings fail closed; hosts must plan archival/migration before
capacity fills instead of dropping audit history. The synchronous file adapter is
for one active service, not horizontally scaled hosting. Host HTTP body/edge rate
limits, private directory permissions, trusted auth/billing/directory adapters,
backups, KMS lifecycle and a production transactional storage adapter remain
prerequisites for deployment. The local rate budget resets on service restart.
Git protocol, UI, HTTP routes, repo-level ACLs and line-level patches are not part
of this backend SDK PR. No production deployment was performed by this review.
