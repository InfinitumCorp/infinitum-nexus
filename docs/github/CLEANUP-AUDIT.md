# GitHub cleanup audit — 9 Nov 2026 (Europe/Moscow)

Snapshot of `InfinitumCorp` at audit time. Cloud-agent tokens are **read-only** for org/repo mutations, so deletions and PR closes must be run by an org admin (or use `scripts/github-hygiene.sh`).

## Org snapshot

| Item | Value |
|---|---|
| Repos | `infinitum-nexus` (private), `scalvs-ru` (public Pages mirror) |
| Open PRs on nexus | 26 |
| Remote branches on nexus | 71 |
| Nexus description / topics | Missing |
| Issue / PR templates | Added in this hygiene PR |
| Dependabot config | Added in this hygiene PR |
| Branch protection | Not readable with current token (verify in UI) |

## Priority actions (admin)

### 1. Repo metadata

In GitHub → Settings for each repo:

**infinitum-nexus**

- Description: `Shared monorepo for Infinitum products (CID, Mail, VEIL, Spectre, Firmament, Labyrinth, …)`
- Topics: `infinitum`, `typescript`, `pnpm`, `monorepo`
- Disable Wiki / Projects if unused
- Homepage: company site or internal docs URL

**scalvs-ru**

- Keep description as Russia mirror
- Topics: `scalvs`, `github-pages`, `mirror`
- Disable Wiki / Projects
- Confirm Pages source is `main`

### 2. Security PR consolidation

Keep **one** VEIL Go crypto upgrade, close the rest as duplicates:

| Keep | Close as superseded |
|---|---|
| [#76](https://github.com/InfinitumCorp/infinitum-nexus/pull/76) `fix/go-crypto-net-vulns` | [#72](https://github.com/InfinitumCorp/infinitum-nexus/pull/72), [#42](https://github.com/InfinitumCorp/infinitum-nexus/pull/42), [#37](https://github.com/InfinitumCorp/infinitum-nexus/pull/37) |

### 3. Conflicting or stale open PRs

Rebase or close — do not leave `CONFLICTING` PRs open indefinitely:

| PR | Branch | Note |
|---|---|---|
| [#54](https://github.com/InfinitumCorp/infinitum-nexus/pull/54) | `feat/open-model-router` | Conflicting with `main` |
| [#53](https://github.com/InfinitumCorp/infinitum-nexus/pull/53) | `feat/unified-app-shell` | Conflicting |
| [#44](https://github.com/InfinitumCorp/infinitum-nexus/pull/44) | `cursor/veil-reproducible-artifacts-9a1f` | Conflicting |
| [#35](https://github.com/InfinitumCorp/infinitum-nexus/pull/35) | `cursor/cumulus-cloud-drive-bb19` | Conflicting |
| [#26](https://github.com/InfinitumCorp/infinitum-nexus/pull/26) | `feat/lbrnth-integrations` | Conflicting; base of a long stack |
| [#6](https://github.com/InfinitumCorp/infinitum-nexus/pull/6) | `brand-consistency` | Oldest open PR; likely superseded by merged UI brand work (#55) — close unless still needed |

Drafts to decide: [#24](https://github.com/InfinitumCorp/infinitum-nexus/pull/24), [#23](https://github.com/InfinitumCorp/infinitum-nexus/pull/23).

### 4. Stacked chains

Review whether these stacks should merge bottom-up or be flattened onto `main`:

- Labyrinth / drones / ingest / orbital / conjure: #26 → #27 → #28 → #29 → #30
- SCALVS: #43 → #58

If the stack parent is abandoned, retarget children to `main` or close the whole chain.

### 5. Delete merged head branches

These heads were merged and should not remain on the remote (non-exhaustive; regenerate with the hygiene script):

```
feat/mail-attachments
feat/mail-outbound-rich
feat/mail-outbound-sending
feat/veil-web-corporate-redesign
feat/mail-google-apple-signin
feat/mail-inbound
fix/windows-test-portability
feat/mail-pwa-android
feat/veil-android-browser-and-web
feat/firm-suite
ui-brand-rollout
chore/rchtch-domain
feat/billing-package
feat/mttrn-domain
cursor/fabric-server-ui-c7be
cursor/veil-release-main-ea5d
cursor/firmament-root-domain-e89b
cursor/firm-root-domain-e89b
cursor/fabric-root-domain-e89b
cursor/cumuluscloud-domain-c56d
cursor/labyrinth-isolated-dcd9
cursor/veil-android-wireguard-c405
cursor/veil-desktop-vpn-a280
cursor/veil-browser-proxy-ea5d
feat/lbrnth-labyrinth
aether/m0-m1-protocol-core
feat/veil-v0.5-nexus-mail
feat/veil-v0.4-workspaces-rewards
feat/mail-schedule-send
feat/mail-search
feat/mail-polish
feat/mail-scalus-clean
feat/mail-tunnel
feat/start-eon-argus-daemon-slug
rename-architct
rename-architect
fix/architect-app-id
product-delivery
metatron-server
veil-production
veil-progress
veil-wallet-rewards
codex/ecosystem-delivery-foundation
```

### 6. Delete backup bookmarks

Replace with tags if needed, then delete:

```
backup/2026-11-07-conjure-product-predictions
backup/2026-11-07-drone-backend
backup/2026-11-07-fabric-mobile-design
backup/2026-11-07-lbrnth-integrations
backup/2026-11-07-lbrnth-labyrinth
backup/2026-11-07-orbital-planning
backup/2026-11-07-reliable-archive-ingest
backup/2026-11-08-lbrnth-labyrinth
backup/2026-11-08
```

## Healthy open work (do not mass-close)

Recent, mergeable product PRs such as #69, #68, #67, #66, #60, #45, #43 should be reviewed on their merits — they are active delivery, not clutter.

## After cleanup

1. Enable **Automatically delete head branches** (Settings → General).
2. Protect `main`: require PR, require status checks (`CI / verify` at minimum).
3. Confirm Dependabot is enabled for the new `.github/dependabot.yml`.
4. Re-run `bash scripts/github-hygiene.sh` monthly.
