# Labyrinth for OpenClaw

By **Infinitum Corporation®**. An [OpenClaw](https://docs.openclaw.ai) tool plugin that lets an
OpenClaw agent use your private Labyrinth repositories, signed in with Cumulus://ID.

| Tool | What it does | Default |
|---|---|---|
| `labyrinth_repositories` | Lists your repositories and branches | on |
| `labyrinth_read` | Reads the latest version of a file the agent saved | on |
| `labyrinth_history` | Lists recent versions with the agent's files in each | on |
| `labyrinth_save` | Saves a file as a new version (earlier versions are kept) | **off until you allowlist it** |

## Safety

- **Its own folder only.** The plugin always calls Labyrinth as the product `openclaw`. The server
  stores and reads its files under `products/openclaw/` in each repository, so the agent cannot
  read or overwrite files that other Infinitum products saved. History lists only its own paths.
- **Short-lived, repository-only credential.** The agent never holds your Cumulus ID session. You
  issue an `lbrnth_…` credential that lasts 15 minutes, works only for repositories, and stops at
  once when you sign out of Cumulus ID or leave your organization.
- **No silent overwrites.** Every save is a compare-and-swap on the branch head. If the file
  changed since the agent looked, the save fails with 409 and nothing is written.
- **Saving is opt-in.** `labyrinth_save` is an optional tool. OpenClaw shows it to the model only
  after you add it to the allowlist. Agents read untrusted content (web pages, mail), so leave it
  off unless you want the agent to write.
- HTTPS only, no redirects, 15-second timeout. The credential never appears in tool results or errors.

## Set up

Requires OpenClaw 2026.5.17 or newer and Node 24.16+.

1. Sign in at <https://id.cumuluscloud.app/labyrinth>. Your organization needs an active Labyrinth plan.
2. Open **Connect OpenClaw** and choose **Issue a 15-minute credential**. Copy it.
3. Give it to OpenClaw as `LBRNTH_TOKEN` (environment variable or SecretRef), or as the plugin's
   `token` setting.
4. Install the plugin:

   ```bash
   pnpm --filter @infinitum/lbrnth-openclaw build
   openclaw plugins install ./packages/lbrnth-openclaw
   openclaw plugins inspect labyrinth --runtime
   ```

5. To let the agent save, allowlist `labyrinth_save` in your OpenClaw tool settings.

Settings (`plugins.labyrinth` in the OpenClaw config):

| Key | Default | Notes |
|---|---|---|
| `endpoint` | `https://id.cumuluscloud.app/api/labyrinth` | In Russia use `https://ru.id.cumuluscloud.app/api/labyrinth` |
| `token` | `LBRNTH_TOKEN` | Prefer the environment variable or a SecretRef |

In OpenClaw, the agent's files show up in the Labyrinth web workspace under **Product artifacts → OpenClaw agent**.

## Develop

```bash
pnpm --filter @infinitum/lbrnth-openclaw test       # node --test, no OpenClaw needed
pnpm --filter @infinitum/lbrnth-openclaw typecheck
node --experimental-strip-types scripts/manifest.ts # regenerate openclaw.plugin.json
openclaw plugins validate --entry ./dist/index.js   # with OpenClaw installed
```

`openclaw.plugin.json` is generated from the same tool definitions as the runtime entry, and a
test fails if it is stale. `types/openclaw-tool-plugin.d.ts` is a typed subset of
`openclaw/plugin-sdk/tool-plugin`, so the monorepo does not install OpenClaw (about 275 MB).
