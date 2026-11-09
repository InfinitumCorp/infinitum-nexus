# Security policy

## Supported software

Report vulnerabilities that affect code in this monorepo (`InfinitumCorp/infinitum-nexus`), including shared packages under `packages/` and product apps under `apps/`.

The public mirror `InfinitumCorp/scalvs-ru` only hosts static GitHub Pages content; treat it as a deploy target, not a second product codebase.

## Reporting a vulnerability

Do **not** open a public GitHub issue for security reports.

Email **security@infinitum.corp** (or your current Infinitum security contact) with:

- Affected package or app path
- Impact and a minimal reproduction
- Whether you believe the issue is already exploitable in production

We will acknowledge receipt and coordinate a fix and disclosure window.

## Dependency alerts

Prefer one consolidated security PR for a given dependency family (for example all `golang.org/x/crypto` bumps) over parallel Dependabot PRs. Close superseded Dependabot PRs when the consolidated change lands.
