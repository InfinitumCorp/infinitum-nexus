import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "./index.ts";
import { cidGraphFromEnv, neo4jGraph, neo4jHttpOrigin, type CidGraph } from "./graph.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("CID graph (Neo4j Query API)", () => {
  it("maps Aura URIs to the HTTPS Query API and refuses plain http", () => {
    assert.equal(neo4jHttpOrigin("neo4j+s://abc123.databases.neo4j.io"), "https://abc123.databases.neo4j.io");
    assert.equal(neo4jHttpOrigin("https://graph.example:7473"), "https://graph.example:7473");
    assert.equal(neo4jHttpOrigin("http://graph.example"), null);
    assert.equal(neo4jHttpOrigin("http://localhost:7474"), "http://localhost:7474");
  });

  it("is off until NEO4J_URI and NEO4J_PASSWORD are set, and CID_GRAPH=off wins", () => {
    assert.equal(cidGraphFromEnv({}), undefined);
    assert.equal(cidGraphFromEnv({ NEO4J_URI: "neo4j+s://x.databases.neo4j.io" }), undefined);
    assert.equal(cidGraphFromEnv({ NEO4J_URI: "neo4j+s://x.databases.neo4j.io", NEO4J_PASSWORD: "p", CID_GRAPH: "off" }), undefined);
    assert.equal(cidGraphFromEnv({ NEO4J_URI: "ftp://x", NEO4J_PASSWORD: "p" }), undefined);
    assert.ok(cidGraphFromEnv({ NEO4J_URI: "neo4j+s://x.databases.neo4j.io", NEO4J_PASSWORD: "p" }));
  });

  it("sends parameterised Cypher with Basic auth to /db/<db>/query/v2", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const g = neo4jGraph({ uri: "neo4j+s://x.databases.neo4j.io", password: "pw", fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response("{}"); }) as unknown as typeof fetch });
    await g.grant("cid_a", "LBRNTH", ["repo:read"], "2026-11-14T00:00:00Z");
    await g.revoke("cid_a", "LBRNTH", [], "t");
    await g.membership("cid_a", "org_1", true);
    assert.equal(calls[0]!.url, "https://x.databases.neo4j.io/db/neo4j/query/v2");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Basic ${btoa("neo4j:pw")}`);
    const first = JSON.parse(String(calls[0]!.init.body));
    assert.match(first.statement, /MERGE \(a:Account \{cid: \$cid\}\)/);
    assert.deepEqual(first.parameters, { cid: "cid_a", app: "LBRNTH", scopes: ["repo:read"], at: "2026-11-14T00:00:00Z" });
    assert.match(JSON.parse(String(calls[1]!.init.body)).statement, /DELETE g/);
    assert.deepEqual(JSON.parse(String(calls[2]!.init.body)).parameters, { cid: "cid_a", org: "org_1", admin: true });
  });

  it("CidService mirrors grants and revokes by opaque id, and a failing graph never blocks", async () => {
    const seen: string[] = [];
    const graph: CidGraph = {
      async grant(cid, app, scopes) { seen.push(`grant ${cid === account.cid} ${app} ${scopes.join(",")}`); throw new Error("neo4j down"); },
      async revoke(_cid, app, remaining) { seen.push(`revoke ${app} ${remaining.join(",") || "-"}`); },
      async membership() { seen.push("membership"); },
    };
    const signer = generateSigner();
    const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "infinitum.example", origins: ["https://infinitum.example"], graph });
    const account = await cid.createAccount({ username: "graphuser" });
    await cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write"]);
    await cid.revoke(account.cid, "LBRNTH", ["repo:write"]);
    await cid.revoke(account.cid, "LBRNTH");
    await tick();
    assert.deepEqual(seen, ["grant true LBRNTH repo:read,repo:write", "revoke LBRNTH repo:read", "revoke LBRNTH -"]);
    assert.equal(await cid.can(account.cid, "LBRNTH", "repo:read"), false);
  });
});
