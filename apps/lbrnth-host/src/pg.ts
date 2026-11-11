import pg from "pg";
import type { SqlDatabase, SqlQueryable } from "@infinitum/lbrnth";

/**
 * node-postgres pool as the Labyrinth SqlDatabase. TLS is always on and always verified;
 * any sslmode in the URL is replaced by these settings.
 */
export function postgresDatabase(url: string, ca?: string): { db: SqlDatabase; close: () => Promise<void> } {
  const parsed = new URL(url);
  parsed.searchParams.delete("sslmode");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    ssl: loopback ? undefined : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: "lbrnth-host",
  });
  pool.on("error", err => console.error("Labyrinth host: idle database client error", err.message));
  const wrap = (client: pg.Pool | pg.PoolClient): SqlQueryable => ({
    query: async <R>(text: string, params?: unknown[]) => ({ rows: (await client.query(text, params as unknown[])).rows as R[] }),
  });
  const db: SqlDatabase = {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(wrap(client));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
  return { db, close: () => pool.end() };
}
