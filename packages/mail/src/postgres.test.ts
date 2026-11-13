/**
 * Cumulus://Mail on PostgreSQL. Runs when CID_TEST_PG_URL is set (CI's Postgres job sets it).
 */
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { PostOffice } from "./postoffice.ts";
import { PgMailRepository, migrateMail, type MailQueryable } from "./postgres.ts";
import { CumulusTunnel, generateMasterKey, parseMasterKey } from "./tunnel.ts";

const url = process.env.CID_TEST_PG_URL;
const { default: pg } = url ? await import("pg") : { default: undefined as never };
const pool = url ? new pg.Pool({ connectionString: url, max: 6, allowExitOnIdle: true }) : undefined;
pool?.on("error", () => {});
const schemas: string[] = [];
after(async () => {
  if (!pool) return;
  for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
});

async function fresh(name: string) {
  const schema = `mail_${name}_${process.pid}`;
  schemas.push(schema);
  await pool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await migrateMail(pool!, schema);
  return schema;
}

/** One request: its own connection and transaction, committed at the end (rolled back on error). */
async function inTransaction<T>(fn: (db: MailQueryable) => Promise<T>, wrap?: (db: MailQueryable) => MailQueryable): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(wrap ? wrap(client) : client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

describe("Cumulus://Mail on PostgreSQL", { skip: url ? false : "set CID_TEST_PG_URL to run" }, () => {
  test("mailboxes, aliases, delivery and the outbound queue live in rows", async () => {
    const schema = await fresh("rows");
    const po = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) });
    await po.provision({ cid: "a", address: "alex@cumuluscloud.app", name: "Alex" });
    await po.provision({ cid: "b", address: "sam@cumuluscloud.app", name: "Sam" });
    await assert.rejects(po.provision({ cid: "c", address: "alex@cumuluscloud.app" }), /another Cumulus:\/\/ID/);
    assert.equal(await po.addAlias("b", "sam.work@cumuluscloud.app"), true);
    assert.equal(await po.addAlias("a", "sam.work@cumuluscloud.app"), false);

    const r = await po.send("a", { to: "sam.work@cumuluscloud.app, priya@example.com", subject: "Plans", body: "3pm?" });
    assert.deepEqual([r.delivered, r.queued], [1, 1]);
    assert.equal((await po.view("b")).messages.filter((m) => m.subject === "Plans").length, 1);
    assert.deepEqual(await po.repository.mailboxCids(), ["a", "b"]);

    const [job] = await po.claimOutbound();
    assert.deepEqual(job.to, ["priya@example.com"]);
    await po.finishOutbound(job.id, { ok: true, providerId: "p1" });
    assert.equal((await po.outboundQueue()).length, 0);
    const { rows } = await pool!.query(`SELECT status FROM "${schema}".mail_outbound`);
    assert.deepEqual(rows.map((x) => x.status), ["sent"]);

    // A fresh PostOffice on the same tables sees the same mail.
    const again = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) });
    assert.equal((await again.view("a")).messages.find((m) => m.folder === "sent")?.delivery?.find((h) => h.email === "priya@example.com")?.detail, "Sent to the recipient's mail server.");
  });

  test("with a tunnel, message content is sealed in the database and opened on read", async () => {
    const schema = await fresh("sealed");
    const tunnel = new CumulusTunnel({ masterKey: parseMasterKey(generateMasterKey()) });
    const po = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema, tunnel }), tunnel });
    await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    await po.provision({ cid: "b", address: "sam@cumuluscloud.app" });
    await po.send("a", { to: "sam@cumuluscloud.app", subject: "Quarterly numbers", body: "Revenue up 12%" });
    const { rows } = await pool!.query(`SELECT data::text AS raw FROM "${schema}".mail_mailboxes`);
    for (const { raw } of rows) {
      assert.doesNotMatch(raw, /Quarterly numbers|Revenue up/, "no plaintext subject or body at rest");
      assert.match(raw, /"sealed"/);
    }
    assert.match((await po.view("b")).messages[0].body, /^Revenue up 12%/);
  });

  test("two deliveries to the same mailbox at once: both are kept", async () => {
    const schema = await fresh("race");
    const setup = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) });
    for (const [cid, address] of [["a", "alex"], ["b", "sam"], ["c", "lee"]]) await setup.provision({ cid, address: `${address}@cumuluscloud.app` });

    // Two servers, each in its own transaction, deliver to Sam. Each waits after reading Sam's mailbox
    // until the other has read it too (or 500 ms pass, which is what happens when the row lock makes
    // the second one wait), so the reads really overlap.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const wrap = (db: MailQueryable): MailQueryable => ({
      async query(text, params) {
        const r = await db.query(text, params);
        if (/FROM "[^"]+"\.mail_mailboxes WHERE cid = \$1/.test(text) && params?.[0] === "b") {
          if (++arrived === 2) release();
          await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
        }
        return r;
      },
    });
    const send = (from: string, subject: string) =>
      inTransaction((db) => new PostOffice({ repository: new PgMailRepository({ db, schema }) }).send(from, { to: "sam@cumuluscloud.app", subject, body: "x" }), wrap);
    await Promise.all([send("a", "From Alex"), send("c", "From Lee")]);
    const subjects = (await setup.view("b")).messages.map((m) => m.subject).sort();
    assert.deepEqual(subjects, ["From Alex", "From Lee"], "neither delivery overwrote the other");
  });

  test("two senders at once never take the same outbound job", async () => {
    const schema = await fresh("claim");
    const po = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) });
    await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    for (let i = 0; i < 6; i++) await po.send("a", { to: `p${i}@example.com`, subject: `Out ${i}`, body: "x" });

    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const wrap = (db: MailQueryable): MailQueryable => ({
      async query(text, params) {
        const r = await db.query(text, params);
        if (/mail_outbound\s+WHERE \(status = .queued./.test(text)) {
          if (++arrived === 2) release();
          await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
        }
        return r;
      },
    });
    const claim = () => inTransaction((db) => new PostOffice({ repository: new PgMailRepository({ db, schema }) }).claimOutbound(4), wrap);
    const [x, y] = await Promise.all([claim(), claim()]);
    const ids = [...x, ...y].map((j) => j.id);
    assert.equal(ids.length, 6, "all six jobs were taken");
    assert.equal(new Set(ids).size, 6, "no job was taken twice");
  });
});
