import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { LabyrinthHost, RemoteCidDirectory, serveLabyrinthHost } from "@infinitum/lbrnth";
import type { SqlDatabase } from "@infinitum/lbrnth";
import { harness } from "./test-harness.ts";

const MIGRATION = readFileSync(new URL("../../../../supabase/migrations/20261111_lbrnth_store.sql", import.meta.url), "utf8");
const DIRECTORY_KEY = "test-directory-key-".padEnd(48, "x");

/**
 * The production shape: id.cumuluscloud.app (this app) stays the Cumulus ID authority and relays
 * /api/labyrinth to the separately hosted Labyrinth (Cloud Run), which checks every token back
 * against this app's /api/id/labyrinth-directory and stores repositories in Postgres.
 */
test("Cumulus ID relays to the hosted Labyrinth, which checks sessions live through the CID directory", async () => {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(MIGRATION);
  const db: SqlDatabase = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: fn => pg.transaction(tx => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  let host: LabyrinthHost | undefined;
  const hostServer = createServer((req, res) => {
    if (req.url === "/api/labyrinth") void serveLabyrinthHost(req, res, host);
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => hostServer.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(hostServer.address() as AddressInfo).port}/api/labyrinth`;
  const h = await harness({ labyrinthEndpoint: endpoint, labyrinthDirectoryKeySha256: createHash("sha256").update(DIRECTORY_KEY).digest("hex") });
  try {
    // The directory refuses anyone without the service key, and never answers a browser.
    const noKey = await h.call("POST", "/api/id/labyrinth-directory", { op: "membership", cid: "cid_x" }, undefined, {});
    assert.equal(noKey.status, 401);
    const wrongKey = await h.call("POST", "/api/id/labyrinth-directory", { op: "membership", cid: "cid_x" }, undefined, { "x-cid-directory-key": "y".repeat(48) });
    assert.equal(wrongKey.status, 401);

    host = new LabyrinthHost({ db, masterKey: new Uint8Array(32).fill(3), directory: new RemoteCidDirectory(`${h.base}/api/id/labyrinth-directory`, DIRECTORY_KEY), entitledOrgs: () => [] });
    const identity = await h.signUp("hosted-lab");
    const viaId = (body: Record<string, unknown>, cookie = identity.cookie) => h.call("POST", "/api/labyrinth", body, cookie, { "x-labyrinth": "1" });

    // Same-origin workspace on id.cumuluscloud.app: the CID cookie travels as the bearer.
    assert.equal((await viaId({ action: "session", product: "spectre" }, "")).status, 401);
    const session = await viaId({ action: "session", product: "spectre" });
    assert.equal(session.status, 200);
    assert.equal(session.body.cid, identity.cid);
    assert.equal(session.body.organization, null);
    const org = await viaId({ action: "organization", product: "spectre", name: "Hosted client" });
    assert.equal(org.status, 200);
    assert.equal((await h.suite.cid.organizationMembership(identity.cid))?.id, org.body.id);
    assert.equal((await viaId({ action: "consent", product: "spectre", scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
    assert.equal((await viaId({ action: "provision", product: "spectre" })).status, 403); // no plan yet
    await pg.query("insert into lbrnth.entitlements (org_id, plan, source) values ($1, 'client', 'operator')", [org.body.id]);
    assert.equal((await viaId({ action: "provision", product: "spectre" })).status, 200);

    // Architect's path: a repository-only bearer straight to the host.
    const token = (await viaId({ action: "token", product: "architect" })).body.token as string;
    const direct = (body: Record<string, unknown>, bearer = token) => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-labyrinth": "1", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ product: "architect", ...body }) }).then(async r => ({ status: r.status, body: await r.json() }));
    const repo = await direct({ action: "create", name: "architect" });
    assert.equal(repo.status, 200);
    const saved = await direct({ action: "save", repo: repo.body.id, path: "runs/1.json", content: "{\"run\":1}", expectedHead: null });
    assert.equal(saved.status, 200);
    assert.equal((await direct({ action: "load", repo: repo.body.id, commit: saved.body.id, path: "runs/1.json" })).body.content, "{\"run\":1}");

    // Signing out of Cumulus ID ends the repository bearer too.
    await h.call("POST", "/api/auth/signout", {}, identity.cookie);
    assert.equal((await direct({ action: "list" })).status, 401);
    assert.equal((await viaId({ action: "list", product: "spectre" })).status, 401);
  } finally {
    await h.close();
    await new Promise<void>(r => hostServer.close(() => r()));
  }
});

test("the directory route stays off without a configured key", async () => {
  const h = await harness();
  try {
    const res = await h.call("POST", "/api/id/labyrinth-directory", { op: "membership", cid: "cid_x" }, undefined, { "x-cid-directory-key": DIRECTORY_KEY });
    assert.equal(res.status, 404);
  } finally { await h.close(); }
});
