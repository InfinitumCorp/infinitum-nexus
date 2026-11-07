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

The encrypted snapshot adapter provides per-org AES-256-GCM at-rest protection,
atomic single-process persistence and fail-closed restore. In-memory transactions
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
