/**
 * Cumulus://ID relationship graph on Neo4j (Aura startup credits). Zero dependencies: it talks to
 * the Neo4j Query API (HTTPS, POST /db/<database>/query/v2), so it runs on Node and Workers.
 *
 * The graph mirrors relationships the service already stores, keyed only by opaque ids:
 *   (:Account {cid})-[:MEMBER_OF {admin}]->(:Org {id})
 *   (:Account {cid})-[:GRANTED {scopes, at}]->(:App {id})
 * No usernames, emails, names, IPs, devices, keys or sessions are sent.
 *
 *   NEO4J_URI        neo4j+s://<id>.databases.neo4j.io (Aura) or https://host[:port]. Unset: off.
 *   NEO4J_USERNAME   default "neo4j";  NEO4J_PASSWORD (secret);  NEO4J_DATABASE default "neo4j"
 *   CID_GRAPH=off    turns it off even when configured
 *
 *   new CidService({ ..., graph: cidGraphFromEnv(process.env) })
 *
 * Writes are best effort: a slow or failing Neo4j never blocks sign-in or a grant.
 */

export interface CidGraph {
  grant(cid: string, app: string, scopes: string[], at: string): Promise<void>;
  revoke(cid: string, app: string, remaining: string[], at: string): Promise<void>;
  membership(cid: string, orgId: string | undefined, admin: boolean): Promise<void>;
}

type Env = Record<string, string | undefined>;

/** neo4j+s://host, neo4j://host, bolt+s://host or https://host -> the Query API origin, or null. */
export function neo4jHttpOrigin(uri: string): string | null {
  try {
    const u = new URL(uri.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (/^(neo4j|bolt)(\+s|\+ssc)?:$/.test(u.protocol)) return `https://${u.hostname}`;
    if (u.protocol === "https:" || (local && u.protocol === "http:")) return u.origin;
    return null;
  } catch {
    return null;
  }
}

export function neo4jGraph(opts: { uri: string; username?: string; password: string; database?: string; fetch?: typeof fetch; timeoutMs?: number }): CidGraph {
  const origin = neo4jHttpOrigin(opts.uri);
  if (!origin) throw new Error("NEO4J_URI must be neo4j+s://, bolt+s:// or https://");
  const url = `${origin}/db/${encodeURIComponent(opts.database || "neo4j")}/query/v2`;
  const auth = `Basic ${btoa(`${opts.username || "neo4j"}:${opts.password}`)}`;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 4_000;

  async function run(statement: string, parameters: Record<string, unknown>) {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: auth },
        body: JSON.stringify({ statement, parameters }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) globalThis.console?.warn?.(`CID graph: Neo4j returned ${res.status}`);
    } catch (err) {
      globalThis.console?.warn?.(`CID graph: ${(err as Error)?.message ?? err}`);
    }
  }

  return {
    grant: (cid, app, scopes, at) =>
      run("MERGE (a:Account {cid: $cid}) MERGE (p:App {id: $app}) MERGE (a)-[g:GRANTED]->(p) SET g.scopes = $scopes, g.at = $at", { cid, app, scopes, at }),
    revoke: (cid, app, remaining, at) =>
      remaining.length
        ? run("MATCH (a:Account {cid: $cid})-[g:GRANTED]->(p:App {id: $app}) SET g.scopes = $remaining, g.at = $at", { cid, app, remaining, at })
        : run("MATCH (a:Account {cid: $cid})-[g:GRANTED]->(p:App {id: $app}) DELETE g", { cid, app }),
    membership: (cid, orgId, admin) =>
      orgId
        ? run("MERGE (a:Account {cid: $cid}) WITH a OPTIONAL MATCH (a)-[old:MEMBER_OF]->(o:Org) WHERE o.id <> $org DELETE old WITH DISTINCT a MERGE (n:Org {id: $org}) MERGE (a)-[m:MEMBER_OF]->(n) SET m.admin = $admin", { cid, org: orgId, admin })
        : run("MATCH (a:Account {cid: $cid})-[m:MEMBER_OF]->(:Org) DELETE m", { cid }),
  };
}

/** The graph from the environment, or undefined when NEO4J_URI / NEO4J_PASSWORD are missing or CID_GRAPH=off. */
export function cidGraphFromEnv(env: Env = globalThis.process?.env ?? {}, opts: { fetch?: typeof fetch } = {}): CidGraph | undefined {
  if (!env.NEO4J_URI || !env.NEO4J_PASSWORD || String(env.CID_GRAPH ?? "").toLowerCase() === "off") return undefined;
  try {
    return neo4jGraph({ uri: env.NEO4J_URI, username: env.NEO4J_USERNAME, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE, fetch: opts.fetch });
  } catch (err) {
    globalThis.console?.warn?.(`CID graph is off: ${(err as Error).message}`);
    return undefined;
  }
}
