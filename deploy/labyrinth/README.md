# Labyrinth persistent service

This deployment runs the existing +SPCTR Cumulus://ID host and Labyrinth workspace
as one non-root container with persistent, private storage. It is a complete local
runtime; it does not assume ephemeral serverless disks or invent a separate identity
provider. Exactly one writer owns the named volume.

1. Copy `environment.example` to a private path outside this repository. Restrict it
   to mode 0600. Supply `LBRNTH_MASTER_KEY` from a secret manager (canonical base64,
   32 bytes). For production, set `LABYRINTH_ORIGIN` to the exact HTTPS URL served
   by your authenticated reverse proxy or Cloudflare Tunnel. Passkeys bind to this
   origin, so do not change it after users enroll without planning migration.
2. Build and start, replacing `/private/labyrinth.env` with that file:

   ```sh
   docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml up -d --build --wait
   ```

3. Open the configured host, create a real Cumulus://ID with a passkey, and choose
   Labyrinth in the navigation. Under First-time organization setup, create your
   organization and explicitly grant the needed repository scopes. Its CID org id
   appears next to your identity. This does not activate a paid plan.
4. After verifying the client's plan, add that exact org id to
   `LBRNTH_ENTITLED_ORGS` in the private environment file. Recreate the container to
   load the changed environment, preserving its volume:

   ```sh
   docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml up -d --force-recreate --wait
   ```

5. In the workspace, provision the organization, create a private repository and
   commit an artifact. Restart once and confirm the version and content remain.

The container binds only to the host's loopback port 3030 by default. Public TLS
routing belongs to your existing hosting configuration; these files do not change
DNS or publish to a production domain. Cookies become Secure when the external
origin uses HTTPS. Keep the volume and its signing/tunnel keys in private backups.
Never run `down --volumes` against a real deployment.

The health check verifies that the workspace responds and the configured API
rejects an anonymous request with 401. Startup refuses a wrong snapshot key.
SIGTERM drains requests before stopping. The image uses a read-only root filesystem,
a 0700 data directory, no Linux capabilities and no new privileges.

## Reproduce the runtime test

From the repository root with Node >=22.18, dependencies installed and Docker:

```sh
docker build -f deploy/labyrinth/Dockerfile -t infinitum-labyrinth:local .
node --experimental-strip-types scripts/test-labyrinth-runtime.ts
```

Managed networks can supply their CA with
`docker build --secret id=proxy_ca,src="$CODEX_PROXY_CERT" ...` or set
`LABYRINTH_BUILD_CA` for Compose. TLS verification remains enabled.

The test creates its own uniquely named container/volume and ephemeral test key.
It covers real passkey signup, organization creation, denial before entitlement,
operator entitlement activation, encrypted binary writes and session/history/content
restoration after restart, offline verify/backup, and restored bytes after key rotation. It removes only its own test container/volume afterward.

Backups, key rotation and integrity checks use the offline commands in
[the build guide](../../docs/LBRNTH-BUILD.md#offline-operations); stop this service
before accessing its volume. Billing is the existing operator-managed allowlist;
no payment checkout, automatic billing, multi-writer database or Git protocol is
claimed by this deployment.

## Offline maintenance inside the deployment

Stop the writer, then run a one-off container on the same volume:

```sh
docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml stop labyrinth
docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml run --rm --no-deps labyrinth node --experimental-strip-types scripts/labyrinth-maintain.ts verify /var/lib/labyrinth/labyrinth.json
docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml run --rm --no-deps labyrinth node --experimental-strip-types scripts/labyrinth-maintain.ts backup /var/lib/labyrinth/labyrinth.json /var/lib/labyrinth/backups/new-backup.json
docker compose --env-file /private/labyrinth.env -f deploy/labyrinth/compose.yaml up -d --wait
```

Use a new backup filename every time; existing files are never overwritten. Copy
backups to your private external backup store separately. For key rotation, supply
`LBRNTH_NEXT_MASTER_KEY` from the secret manager to a one-off container with
`run -e LBRNTH_NEXT_MASTER_KEY`, invoke `rotate` with a new destination, and
set `LBRNTH_SNAPSHOT_FILE` to the verified new path on the same volume, configure
the new master key, and follow the stop/configure/restart procedure in the operator guide. Keep both keys
and the original snapshot until the restored service is verified.
