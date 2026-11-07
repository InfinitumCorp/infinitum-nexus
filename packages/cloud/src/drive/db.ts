import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** Split a migration file on semicolons. Comments in these files are line comments only. */
export function splitSql(sql: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, "");
  return stripped
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function migrationsDir(): string {
  return fileURLToPath(new URL("../../migrations/", import.meta.url));
}

export function openPool(databaseUrl: string): pg.Pool {
  pg.types.setTypeParser(20, (value) => Number(value));
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    application_name: "cumulus-cloud",
  });
}

/** Apply packages/cloud/migrations in order. Safe to call on every process start. */
export async function migrate(pool: pg.Pool, dir = migrationsDir()): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const seen = await pool.query(`SELECT 1 FROM cloud_schema_migrations WHERE id = $1`, [file]);
    if ((seen.rowCount ?? 0) > 0) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const statement of splitSql(sql)) await client.query(statement);
      await client.query(`INSERT INTO cloud_schema_migrations (id) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already be aborted.
      }
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}
