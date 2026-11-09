# InfinitumCorp GitHub standards

How we keep the company GitHub readable as the monorepo grows.

## Repositories

| Repo | Role | Visibility |
|---|---|---|
| `infinitum-nexus` | Canonical product monorepo | Private |
| `scalvs-ru` | Static Russia mirror of scalvs.app (GitHub Pages only) | Public |

Do **not** open new product repositories by default. New Infinitum software lands in `apps/` or `packages/` inside `infinitum-nexus` unless there is a hard isolation reason (legal, customer-private fork, or a pure static mirror like `scalvs-ru`).

Every repo should have:

- A one-line **description**
- Useful **topics** (product names, `typescript`, `pnpm`, etc.)
- Wiki **off** unless someone actively maintains it
- Projects **off** unless the team uses GitHub Projects

## Branch naming

| Prefix | Use |
|---|---|
| `feat/` | New capability |
| `fix/` | Bug fix |
| `docs/` | Docs only |
| `chore/` | Tooling, deps hygiene, renames |
| `security/` | Vulnerability fixes (prefer over many Dependabot PRs) |
| `cursor/` | Cloud-agent working branches (short-lived) |
| `backup/` | **Discouraged** — use tags or draft PRs instead |

Rules:

1. One concern per branch.
2. Delete the head branch when the PR merges.
3. Do not leave `backup/*` branches on the remote; tag the commit if you need a bookmark (`git tag archive/<slug> <sha>`).
4. Agent branches must match `cursor/<descriptive-name>-xxxx` and are deleted after merge or close.

## Pull requests

1. Open against `main` unless you are intentionally stacking a short series.
2. Stacks must be documented in the PR body and rebased promptly; abandon stacks that conflict for more than a few days.
3. Prefer **draft** for design-only or incomplete work.
4. Close duplicates instead of leaving parallel PRs for the same dependency bump.
5. Keep the open PR count small enough to review — park long-running ideas as issues, not half-merged branches.

## CI

- Default CI runs on pull requests and pushes to `main`.
- Product workflows (VEIL, FABRIC) run on pull requests that touch their paths, and on `main`.
- Avoid `on: push:` with no branch filter — it burns minutes on every agent branch.

## Labels

Use the default labels plus:

- `dependencies` / `go` — Dependabot
- Area labels may be added later (`mail`, `veil`, `labyrinth`); do not invent ad-hoc labels per PR without a shared list.

## Secrets and apps

OAuth apps, deploy tokens, and Cloudflare credentials stay in the host environment or secret manager — never in the repo, never in PR descriptions.
