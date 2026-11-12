/**
 * A test repository that behaves like a database: every value is deep-copied on the way in and on the
 * way out, so CidService can't depend on mutating an object it read. Any change that isn't followed
 * by an explicit put/delete is lost here, and the tests that exercise it fail.
 *
 * Turn it on for the CID suites with CID_TEST_COPYING_REPO=1 (the package's test script runs both).
 */
import { CidStore } from "../service.ts";
import type { CidOneTime } from "../service.ts";
import { MapCidRepository, type CidRepository, type OneTimeKind } from "../repository.ts";
import { PgCidRepository } from "../postgres.ts";

const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

export class CopyingCidRepository implements CidRepository {
  readonly #inner = new MapCidRepository(new CidStore());

  async account(cid: string) { return copy(await this.#inner.account(cid)); }
  async cidForUsername(u: string) { return this.#inner.cidForUsername(u); }
  async putAccount(a: Parameters<CidRepository["putAccount"]>[0]) { return this.#inner.putAccount(copy(a)); }
  async accountsInOrg(orgId: string) { return copy(await this.#inner.accountsInOrg(orgId)); }

  async cidForIdentity(k: string) { return this.#inner.cidForIdentity(k); }
  async setIdentity(k: string, cid: string) { return this.#inner.setIdentity(k, cid); }
  async deleteIdentity(k: string) { return this.#inner.deleteIdentity(k); }
  async cidForFederation(k: string) { return this.#inner.cidForFederation(k); }
  async setFederation(k: string, cid: string) { return this.#inner.setFederation(k, cid); }

  async authenticator(id: string) { return copy(await this.#inner.authenticator(id)); }
  async authenticatorByCredential(c: string) { return copy(await this.#inner.authenticatorByCredential(c)); }
  async authenticatorsOf(cid: string) { return copy(await this.#inner.authenticatorsOf(cid)); }
  async putAuthenticator(a: Parameters<CidRepository["putAuthenticator"]>[0]) { return this.#inner.putAuthenticator(copy(a)); }
  async deleteAuthenticator(a: Parameters<CidRepository["deleteAuthenticator"]>[0]) { return this.#inner.deleteAuthenticator(copy(a)); }

  async session(id: string) { return copy(await this.#inner.session(id)); }
  async sessionByTokenHash(h: string) { return copy(await this.#inner.sessionByTokenHash(h)); }
  async sessionsOf(cid: string) { return copy(await this.#inner.sessionsOf(cid)); }
  async putSession(s: Parameters<CidRepository["putSession"]>[0]) { return this.#inner.putSession(copy(s)); }

  async grant(cid: string, app: string) { return copy(await this.#inner.grant(cid, app)); }
  async grantsOf(cid: string) { return copy(await this.#inner.grantsOf(cid)); }
  async putGrant(g: Parameters<CidRepository["putGrant"]>[0]) { return this.#inner.putGrant(copy(g)); }
  async deleteGrant(cid: string, app: string) { return this.#inner.deleteGrant(cid, app); }

  async org(id: string) { return copy(await this.#inner.org(id)); }
  async putOrg(o: Parameters<CidRepository["putOrg"]>[0]) { return this.#inner.putOrg(copy(o)); }

  async putOneTime<K extends OneTimeKind>(kind: K, key: string, value: CidOneTime[K]) { return this.#inner.putOneTime(kind, key, copy(value)); }
  async peekOneTime<K extends OneTimeKind>(kind: K, key: string) { return copy(await this.#inner.peekOneTime(kind, key)); }
  async takeOneTime<K extends OneTimeKind>(kind: K, key: string) { return copy(await this.#inner.takeOneTime(kind, key)); }
  async deleteOneTime(kind: OneTimeKind, key: string) { return this.#inner.deleteOneTime(kind, key); }
  async sweepOneTime(kind: OneTimeKind, now: number) { return this.#inner.sweepOneTime(kind, now); }
}

// CID_TEST_PG=1 runs the suites on PostgreSQL (CID_TEST_PG_URL), one fresh schema per CidService.
const pgPool = process.env.CID_TEST_PG ? await openTestPool() : null;
let schemas = 0;

async function openTestPool() {
  const url = process.env.CID_TEST_PG_URL;
  if (!url) throw new Error("CID_TEST_PG needs CID_TEST_PG_URL");
  const { default: pg } = await import("pg");
  // allowExitOnIdle: the test process ends once the suite is done instead of waiting on the pool.
  const pool = new pg.Pool({ connectionString: url, max: 4, allowExitOnIdle: true });
  // Drop this run's schemas once the suite is done (beforeExit allows async work; run it once).
  let cleaned = false;
  process.on("beforeExit", () => {
    if (cleaned) return;
    cleaned = true;
    void (async () => {
      const { rows } = await pool.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1", [`cid_test_${process.pid}_%`]);
      for (const r of rows) await pool.query(`DROP SCHEMA IF EXISTS "${r.schema_name}" CASCADE`);
      await pool.end();
    })().catch(() => undefined);
  });
  return pool;
}

/**
 * The repository the CID test suites should use: Postgres when CID_TEST_PG is set, copying when
 * CID_TEST_COPYING_REPO is set, otherwise the default in-memory store.
 */
export function testRepository(): CidRepository | undefined {
  if (pgPool) {
    const schema = `cid_test_${process.pid}_${Date.now().toString(36)}_${++schemas}`;
    return new PgCidRepository({ db: pgPool, schema, migrate: true });
  }
  return process.env.CID_TEST_COPYING_REPO ? new CopyingCidRepository() : undefined;
}
