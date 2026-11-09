# Labyrinth (LBRNTH) — client repository design

**Infinitum Corporation®** provides Labyrinth as a built-in private repository
capability for client organizations in its products, not as shared internal storage.

Implementation and integration contract: [SDK documentation](../packages/lbrnth/README.md).

## Chosen boundary

A shared server-side TypeScript SDK follows Nexus's package model. Existing CID
`can()` controls app consent; a separate trusted billing callback gates each client
org's plan. Org membership supplies owner/admin/writer/reader roles. Keeping these
three checks separate prevents user-consent grants from impersonating a purchase
or crossing a client boundary. A trusted directory also authorizes provisioning.

Versioned full trees reference SHA-256 objects. Immutable parent-linked commits,
CAS branch heads, immutable tags, historical byte reads and file-level diffs give
products a stable integration surface without assuming a Git server or UI.

Hosts that expose Labyrinth to a browser allow only the exact Cumulus origins
(`https://id.cumuluscloud.app`, `https://cloud.cumuluscloud.app`,
`https://mail.cumuluscloud.app` by default). CORS is not a wildcard.
Cumulus://ID's issuer is the Keycloak realm
`https://id.cumuluscloud.app/realms/cumulus`, with JWKS at
`https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs`.

The encrypted snapshot adapter provides per-org AES-256-GCM at-rest protection,
atomic snapshot persistence with exclusive writer locking/revision CAS and fail-closed restore. In-memory transactions
publish only after storage succeeds. Hash-chained audit records successful access
and changes. No private source or raw artifact bytes enter audit entries.

## Alternatives and tradeoffs

- A Git provider integration would offer mature Git protocol and UI but add a
  third-party account dependency and would not itself supply client entitlements.
- A distributed database/object-store service scales better but needs deployment,
  migration, KMS and consistency choices not established by this repository.
- The selected SDK plus encrypted local adapter is self-contained and testable,
  with explicit production limits and a storage extension point. It is a first
  backend capability, not a claim of a deployed, horizontally scaled hosting service.

## Acceptance and review

Tests cover cross-client isolation across APIs, membership and owner safety,
actual CID grants/revocation with independent paid entitlement, version integrity,
binary content, file diffs, branches/tags, lost-update rejection, hostile paths,
failed persistence rollback, encrypted restart and tampered snapshot rejection.
The PR is for review only; no deployment or merge is authorized by this change.

## Security review hardening

Strict literal-true authorization checks deny accidental async/truthy authority results.
Encrypted file locking plus revision comparison rejects stale service snapshots,
including stale writes on another org, before replacement. Payload preflight,
retained-state ceilings and separate per-org operation budgets bound resource abuse;
production still requires edge limits and a scalable storage/retention strategy.
