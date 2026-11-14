# Cumulus://ID relationship graph (Neo4j Aura)

`packages/cid/src/graph.ts` mirrors relationships that Cumulus://ID already stores into Neo4j (Aura startup credits),
using the Neo4j Query API over HTTPS (no driver, works on Workers):

    (:Account {cid})-[:MEMBER_OF {admin}]->(:Org {id})        issuer org claims (adoptUpstream / SSO)
    (:Account {cid})-[:GRANTED {scopes, at}]->(:App {id})     grant() / revoke()

- Only opaque ids. No usernames, emails, names, IPs, devices, keys, sessions or ledger payloads.
- Turn it on with `new CidService({ ..., graph: cidGraphFromEnv(env) })`. It stays off until `NEO4J_URI` + `NEO4J_PASSWORD` are set; `CID_GRAPH=off` disables it.
  CumulusSuite passes `graph` through its CID config.
- Fire-and-forget with a 4 s timeout: Neo4j trouble never blocks sign-in, grants or revokes.
- Not included: backfilling existing accounts, and reads/queries (no product feature uses the graph yet).
- Never put VEIL, FabriC, ODIN or mail content in this graph.

Aura activation (William): 1) sign in at console.neo4j.io and create an AuraDB Professional instance; 2) add a billing
method (required to release credits, charged only after credits run out); 3) reply to startups@neo4j.com with
Organization ID and Project ID (the Org ID email went 2026-11-13 23:01 MSK; Project ID and confirmation of steps 1 and 3 may still be needed).
