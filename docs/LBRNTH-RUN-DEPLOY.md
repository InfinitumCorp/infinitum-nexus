# Labyrinth run and deploy plan

This document is a plan. It does not deploy Labyrinth, change DNS, publish a package, or edit the Infinitum company website.

Current workspace UI, binary/batch API, paging and maintenance commands are documented
in [LBRNTH-BUILD.md](LBRNTH-BUILD.md). The source/CI figures below describe the
previous release baseline; this build records fresh validation in its PR.

## States

| State | Where it stands |
|---|---|
| Source | Located and extracted. Canonical Labyrinth is the SDK merged to `main` in PR #25, plus the Cumulus ID integration in PR #26 (`feat/lbrnth-integrations`, commit `e3938ea`). This branch is `main` plus that integration, release tests, CI, and this plan. PR #29 and PR #30 are not imported. |
| Built | Local pack succeeded for `@infinitum/lbrnth@0.1.0` and `@infinitum/lbrnth-client@0.1.0`. Tarballs are gitignored. They are not published. CI uploads the same pack as artifacts. |
| Tested | Local `pnpm typecheck` and `pnpm test` passed: 433 tests, 0 failures, on Node 22.23.4 and pnpm 10.28.0, including the release tests below. GitHub Actions run [42380479972](https://github.com/InfinitumCorp/infinitum-nexus/actions/runs/42380479972) passed the same install, typecheck, test, security script, and pack. This row is not a deployment. |
| Deployed | Not deployed. No host, DNS record, Vercel project, or registry publish was changed. |

## Source

| Item | Value |
|---|---|
| Repository | `InfinitumCorp/infinitum-nexus` |
| SDK path | `packages/lbrnth` |
| Browser client path | `packages/lbrnth-client` |
| Integration already on main | PR #25, `packages/lbrnth` through commit `c25f43b` |
| Integration added here | PR #26, https://github.com/InfinitumCorp/infinitum-nexus/pull/26 |
| Latest source branch for that integration | `feat/lbrnth-integrations` |
| This isolated branch | `cursor/labyrinth-isolated-dcd9` |

`gh repo list InfinitumCorp` returned only `infinitum-nexus`. Named lookups for `infinitum-corporation-site`, `labyrinth`, `lbrnth`, `conjure`, and `scalvs-forecasts` returned 404 with this credential. GitHub code search across the org is not permitted by the token. No second Labyrinth repository was visible.

## Dependencies brought in, and why

PR #26 is the whole integration. Nothing from the orbital or CONJURE stacks (PR #29, PR #30) is included. Labyrinth does not import `@infinitum/orbital`, `packages/conjure-backend`, or `packages/event-ingest`.

| Dependency | Why it is here |
|---|---|
| `@infinitum/lbrnth-client` | Browser and Worker transport. It has no filesystem, key store, or CID dependency. |
| `CidService.isSessionActive` and `organizationMembership` | `CidLabyrinth` refuses raw CID strings and reads the live directory org and parent session. |
| Extra `INFINITUM_APPS` ids and the `scalus` → `scalvs` alias | Product ids the client sends must already be CID app ids. |
| Optional `CumulusSuite.labyrinth` | +SPCTR and Cumulus Mail pass the deployment config into the existing account suite. |
| `packages/*/src/labyrinth.ts` and the app adapters | Explicit save/load clients. The existing Conjure package only re-exports `createConjureLabyrinth`. The scenario engine is untouched. |
| `POST /api/labyrinth` on +SPCTR and Cumulus Mail | Authenticated repository route. Without `LBRNTH_MASTER_KEY` the route returns 503. |
| Architect `serveNodeLabyrinthProxy` | Relay only. It forwards an explicit bearer to `LBRNTH_ENDPOINT` and does not open its own snapshot. |
| `@infinitum/firmament` and `@infinitum/cid` | Already on `main`. CID sessions and the ledger are how sign-in works. This is not the orbital planner. |
| `typescript` 5.9.3 (Apache-2.0), `@types/node` 22.20.5 and `undici-types` 6.21.0 (MIT) | Existing dev dependencies. `pnpm licenses list` showed no other third-party packages. No new runtime npm dependency. |

## Release tests

`packages/lbrnth/src/release.test.ts` and the +SPCTR case in `apps/spectre/src/server/labyrinth.http.test.ts` cover:

- Deployment config. A missing or empty `LBRNTH_MASTER_KEY` yields no storage. A non-canonical or wrong-length key throws. The allowlist is fail-closed, including a missing variable, and is read on each call. Parsing config does not create a snapshot file.
- Key lifecycle. The master key and plaintext stay out of the snapshot. A running process keeps the key captured at startup; editing the env var does not rekey it. A new process with a different key cannot read the file. Org envelope ids are not interchangeable. Rotation is an explicit re-encrypt onto a new file.
- Snapshot restore. A new `CidLabyrinth` reloads history and file bytes from the snapshot. A stale `.lock` rejects the write and leaves the previous file intact. A tampered envelope refuses to start. A decrypted but hash-corrupted snapshot fails the integrity check. The +SPCTR route writes that snapshot and a second service reads it back; clearing the allowlist returns 403 and does not rewrite the file.

## Must-have scope

- Private per-organization repositories, CID session checks on every call, and no public read.
- Encrypted single-writer snapshot for a long-lived +SPCTR or Cumulus Mail process.
- Operator key plus an explicit org allowlist. No free plan and no generated key in the repo.
- Product artifact adapters and the Architect-style bearer relay.
- Tests, typecheck, dependency and license scan, secrets scan, and a packable tarball.

## Blockers

- There is no billing integration. `LBRNTH_ENTITLED_ORGS` is a manual allowlist.
- There is no KMS. The 32-byte key lives in the process environment. Losing it makes the snapshot unreadable. Rotation is stop-the-writer, load with the old key, save to a new file with the new key, replace the file, start once.
- One active writer. A leftover `.lock` fails closed. Nothing deletes a stale lock automatically.
- The file snapshot is the wrong store for ephemeral serverless disks. Hosted +SPCTR on short-lived instances stays blocked until a transactional adapter exists.
- No Git protocol or firmware sync. The shared repository UI is available at `/labyrinth` in both hosts.
- THRONE, SERAPHIM, CHERUBIM, AZRAIL, and NEMESIS are registry entries only.
- Audit is encrypted and hash-chained. It is not anchored outside the snapshot.
- Relays do nothing useful until an operator sets `LBRNTH_ENDPOINT` to the one authoritative writer. This plan does not set that.
- Separate CID stores are not federated.
- Aikido SAST was not run: the Aikido connector is installed and requires sign-in. The local audit, license inventory, and secrets scan did run.

## Local run

Do this only on a machine you control. Do not commit the key or the snapshot.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack:labyrinth
pnpm security:labyrinth
```

Generate a 32-byte key outside the repo and check that `Buffer.from(value, "base64")` is 32 bytes and that `toString("base64")` returns the same string. Export it as `LBRNTH_MASTER_KEY`. Export `LBRNTH_ENTITLED_ORGS` as a comma-separated list of real CID org ids. Leave both unset to keep `/api/labyrinth` at 503.

+SPCTR reads those variables in `apps/spectre/src/server/main.ts` and stores the snapshot at `$SPECTRE_DATA_DIR/labyrinth.json`. Cumulus Mail does the same under its data directory. Start either process with Node 22.18 or newer. Architect, and any other relay, additionally needs `LBRNTH_ENDPOINT` aimed at that one writer. The relay does not accept a CID cookie as a substitute for an explicit bearer.

A denied allowlist entry returns 403. A wrong key on the next process start refuses to load. After a crash, confirm no writer is running before removing `labyrinth.json.lock`.

## Deploy plan, not to be executed here

1. Keep a private backup of the snapshot and store the master key in the host secret manager. Do not put either in git, logs, or the company website.
2. Run one long-lived +SPCTR or Cumulus Mail process as the writer. Do not point two writers at the same file.
3. Set `LBRNTH_MASTER_KEY` and `LBRNTH_ENTITLED_ORGS` in that process only.
4. Point every relay's `LBRNTH_ENDPOINT` at that writer's `https://<host>/api/labyrinth`. HTTPS is required except loopback.
5. Confirm `POST /api/labyrinth` is 503 before the key exists, then 401 without a CID session, then succeeds for an entitled org.
6. Restore by stopping the writer and starting a new process with the same key and the backed-up file. Do not start a second writer against the live file.
7. Rotate by the re-encrypt procedure covered in the release test. There is no in-place rotate call. The offline `pnpm labyrinth:maintain rotate` command writes and verifies a new snapshot; see the workspace guide.
8. Do not enable this on ephemeral Vercel disks. Do not change DNS. Do not publish the tarballs. Do not merge this PR as part of the plan.

## Security evidence

Regenerate with `bash scripts/labyrinth-security.sh docs/security/labyrinth`.

Local result on this branch: `pnpm audit` reported 0 high and 0 critical across 30 dependencies. License groups were MIT (`@types/node` 22.20.5, `undici-types` 6.21.0) and Apache-2.0 (`typescript` 5.9.3). The secrets scan reported 0 hits.

Local pack checksums:

```text
c23c152dbda8a26c318560c00ca6e1c5fbb6483231d4e991b58d8aafe9ad9983  infinitum-lbrnth-0.1.0.tgz
b4d6e28925510fd5019389680ee2175620ff54be8b746c9eabe64e2eb83340d5  infinitum-lbrnth-client-0.1.0.tgz
```

CI (`.github/workflows/ci.yml`) repeats install from the lockfile, typecheck, test, the security script, and the pack, and uploads both artifacts. Re-run the pack after any source change; these checksums match the tree that produced them.
