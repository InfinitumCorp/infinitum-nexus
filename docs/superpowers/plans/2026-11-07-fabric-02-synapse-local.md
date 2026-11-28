# Local Synapse for FabriC++ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Synapse + PostgreSQL that matches spec section 7: closed registration, federation off, Postgres, localhost only, plus a check that proves stored messages are encrypted.

**Architecture:** Docker Compose runs the unmodified `matrixdotorg/synapse:v1.164.2` image and `postgres:16`. Synapse's own `generate` command writes the config; a small patch script sets the release-1 options. Shell checks call the Matrix HTTP API and query Postgres.

**Tech Stack:** Docker Compose, Synapse v1.164.2, PostgreSQL 16, bash, curl, jq.

## Global Constraints

- `enable_registration: false`; accounts only via `register_new_matrix_user` with the shared secret, or registration tokens.
- Federation off: `federation_domain_whitelist: []` and no `federation` resource on any listener.
- Postgres, not SQLite. Ports bound to `127.0.0.1` only. Plain HTTP is allowed only on localhost.
- Unmodified Synapse image (AGPL source-offer duties apply to modified versions; see index, decision 4).
- Nothing is deployed or exposed publicly. The public domain, not used by this local plan, is `infinitumfabric.app`, hosted at Cloudflare.

Location: `<app-repo>/server/` where `<app-repo>` is the repo chosen in index decision 1.

Requires a machine with Docker. The Linux box used for planning has no Docker.

---

### Task 1: Compose file and generated config

**Files:**
- Create: `<app-repo>/server/docker-compose.yml`
- Create: `<app-repo>/server/configure.sh`
- Create: `<app-repo>/server/.gitignore`

**Interfaces:**
- Produces: Synapse client API at `http://127.0.0.1:8008`, server name `fabric.localhost`, Postgres container `db`, database/user `synapse`.

- [ ] **Step 1: Write the files**

`server/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: synapse
      POSTGRES_PASSWORD: synapse-local-only
      POSTGRES_DB: synapse
      POSTGRES_INITDB_ARGS: "--encoding=UTF-8 --lc-collate=C --lc-ctype=C"
    volumes: ["./pgdata:/var/lib/postgresql/data"]
    ports: ["127.0.0.1:5432:5432"]
  synapse:
    image: matrixdotorg/synapse:v1.164.2
    depends_on: [db]
    volumes: ["./data:/data"]
    ports: ["127.0.0.1:8008:8008"]
```

`server/.gitignore`:

```
data/
pgdata/
```

`server/configure.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f data/homeserver.yaml ]; then
  docker run --rm -v "$PWD/data:/data" -e SYNAPSE_SERVER_NAME=fabric.localhost \
    -e SYNAPSE_REPORT_STATS=no matrixdotorg/synapse:v1.164.2 generate
fi
python3 - <<'PY'
import re
p = "data/homeserver.yaml"
s = open(p).read()
s = re.sub(r"(?ms)^database:\n(?:  .*\n)+", "", s)
s = re.sub(r"(?ms)^listeners:\n(?:  .*\n|    .*\n|      .*\n|        .*\n)+", "", s)
s += """
database:
  name: psycopg2
  args:
    user: synapse
    password: synapse-local-only
    database: synapse
    host: db
    cp_min: 2
    cp_max: 5
listeners:
  - port: 8008
    type: http
    tls: false
    x_forwarded: false
    bind_addresses: ['0.0.0.0']
    resources:
      - names: [client]
        compress: false
enable_registration: false
federation_domain_whitelist: []
allow_public_rooms_over_federation: false
encryption_enabled_by_default_for_room_type: all
"""
open(p, "w").write(s)
PY
echo "configured"
```

- [ ] **Step 2: Run it**

Run: `cd server && chmod +x configure.sh && ./configure.sh && docker compose up -d && sleep 10 && curl -s http://127.0.0.1:8008/_matrix/client/versions | jq -r '.versions | length'`
Expected: `configured`, then a number greater than 0. If `generate` fails or the image tag is missing, stop and re-check the tag in the index.

- [ ] **Step 3: Commit**

```bash
git add server/docker-compose.yml server/configure.sh server/.gitignore
git commit -m "server: local Synapse v1.164.2 + Postgres, registration closed, federation off"
```

### Task 2: Server policy checks

**Files:**
- Create: `<app-repo>/server/check-policy.sh`

- [ ] **Step 1: Write the check**

```bash
#!/usr/bin/env bash
set -uo pipefail
H=${H:-http://127.0.0.1:8008}
fail=0
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/_matrix/client/versions")
if [ "$code" != "200" ]; then echo "FAIL server not reachable ($code)"; exit 1; fi
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$H/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' -d '{"username":"intruder","password":"x-123456789","auth":{"type":"m.login.dummy"}}')
if [ "$code" = "200" ]; then echo "FAIL open registration"; fail=1; else echo "ok registration closed ($code)"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/_matrix/federation/v1/version")
if [ "$code" = "200" ]; then echo "FAIL federation endpoint served"; fail=1; else echo "ok federation not served ($code)"; fi
exit $fail
```

- [ ] **Step 2: See it fail with the server stopped**

Run: `cd server && docker compose stop synapse && bash check-policy.sh; echo "exit=$?"; docker compose start synapse && sleep 10`
Expected: `FAIL server not reachable (000)` and `exit=1`.

- [ ] **Step 3: Run against the configured server**

Run: `bash server/check-policy.sh; echo "exit=$?"`
Expected: `ok registration closed (` followed by a 4xx code, `ok federation not served (404)`, `exit=0`.

- [ ] **Step 4: Commit**

```bash
git add server/check-policy.sh
git commit -m "server: policy check for closed registration and no federation"
```

### Task 3: Test accounts and the plaintext check

**Files:**
- Create: `<app-repo>/server/make-users.sh`
- Create: `<app-repo>/server/check-no-plaintext.sh`

**Interfaces:**
- Produces: users `@alice:fabric.localhost` and `@bob:fabric.localhost` with passwords from env `ALICE_PW`, `BOB_PW`.
- Produces: `check-no-plaintext.sh MARKER` exits 1 if `MARKER` appears in any stored event JSON, else 0, and prints the count of `m.room.encrypted` events.

- [ ] **Step 1: Write the scripts**

`server/make-users.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${ALICE_PW:?set ALICE_PW}" "${BOB_PW:?set BOB_PW}"
docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u alice -p "$ALICE_PW" --no-admin http://localhost:8008
docker compose exec -T synapse register_new_matrix_user -c /data/homeserver.yaml -u bob -p "$BOB_PW" --no-admin http://localhost:8008
```

`server/check-no-plaintext.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
M="${1:?usage: check-no-plaintext.sh MARKER}"
q() { docker compose exec -T db psql -U synapse -d synapse -tAc "$1"; }
hits=$(q "select count(*) from event_json where json like '%' || '$M' || '%'")
enc=$(q "select count(*) from events where type = 'm.room.encrypted'")
echo "plaintext hits: $hits; encrypted events: $enc"
[ "$hits" = "0" ]
```

- [ ] **Step 2: Prove the check catches plaintext (negative control)**

Run:

```bash
cd server && ALICE_PW=alice-local-pw BOB_PW=bob-local-pw ./make-users.sh
T=$(curl -s -X POST http://127.0.0.1:8008/_matrix/client/v3/login -H 'Content-Type: application/json' \
  -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"alice"},"password":"alice-local-pw"}' | jq -r .access_token)
R=$(curl -s -X POST http://127.0.0.1:8008/_matrix/client/v3/createRoom -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"preset":"private_chat","initial_state":[]}' | jq -r .room_id)
curl -s -X PUT "http://127.0.0.1:8008/_matrix/client/v3/rooms/$R/send/m.room.message/neg1" -H "Authorization: Bearer $T" \
  -H 'Content-Type: application/json' -d '{"msgtype":"m.text","body":"PLAINTEXT-CANARY-1"}'
./check-no-plaintext.sh PLAINTEXT-CANARY-1; echo "exit=$?"
```

Expected: the `send` call returns an `event_id` (Synapse does not stop a raw client from sending plaintext into a room, even one with encryption on by default; that is the client's job). The script prints `plaintext hits: 1` and `exit=1`. This proves the check works. Then `docker compose down -v && rm -rf data pgdata` and rerun Task 1 to start clean.

- [ ] **Step 3: Commit**

```bash
git add server/make-users.sh server/check-no-plaintext.sh
git commit -m "server: test users and stored-plaintext check"
```

The positive run of `check-no-plaintext.sh` (exit 0 with encrypted events > 0) happens in Stage 3, after the app sends a real encrypted message.
