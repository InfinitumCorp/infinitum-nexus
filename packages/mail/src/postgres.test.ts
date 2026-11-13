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
    await po.send("a", { to: "sam@cumuluscloud.app, priya@example.com", subject: "Quarterly numbers", body: "Revenue up 12%" });
    const { rows } = await pool!.query(`SELECT data::text AS raw FROM "${schema}".mail_messages`);
    assert.equal(rows.length, 2, "Alex's copy in Sent and Sam's in the inbox");
    for (const { raw } of rows) {
      assert.doesNotMatch(raw, /Quarterly numbers|Revenue up/, "no plaintext subject or body at rest");
      assert.match(raw, /"sealed"/);
    }
    const all = await pool!.query(`SELECT data::text AS raw FROM "${schema}".mail_mailboxes UNION ALL SELECT data::text FROM "${schema}".mail_outbound`);
    for (const { raw } of all.rows) assert.doesNotMatch(raw, /Quarterly numbers|Revenue up/, "nor in mailbox or outbound rows");
    assert.match((await po.view("b")).messages[0].body, /^Revenue up 12%/);
    const [job] = await po.claimOutbound();
    assert.equal(job.subject, "Quarterly numbers");
    assert.match(job.text, /^Revenue up 12%/);
  });

  test("two servers with the same master key share each account's tunnel keys through the database", async () => {
    const schema = await fresh("keys");
    const master = generateMasterKey();
    // Separate processes: each tunnel starts with an empty key store of its own.
    const server = () => {
      const tunnel = new CumulusTunnel({ masterKey: parseMasterKey(master) });
      return { tunnel, po: new PostOffice({ repository: new PgMailRepository({ db: pool!, schema, tunnel }), tunnel }) };
    };
    const one = server();
    await one.po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    await one.po.provision({ cid: "b", address: "sam@cumuluscloud.app" });
    await one.po.send("a", { to: "sam@cumuluscloud.app", subject: "From server one", body: "hi" });

    const two = server();
    assert.equal(two.tunnel.has("b"), false);
    assert.equal((await two.po.view("b")).messages[0].subject, "From server one", "server two opens mail sealed on server one");
    await two.po.send("b", { to: "alex@cumuluscloud.app", subject: "Reply from server two", body: "hey" });
    assert.equal(two.tunnel.fingerprint("a"), one.tunnel.fingerprint("a"), "no second set of keys was made for Alex");
    assert.equal((await one.po.view("a")).messages.find((m) => m.folder === "inbox")?.subject, "Reply from server two");
    const { rows } = await pool!.query(`SELECT cid, data::text AS raw FROM "${schema}".mail_tunnel_keys ORDER BY cid`);
    assert.deepEqual(rows.map((r) => r.cid), ["a", "b"]);
    for (const { raw } of rows) assert.doesNotMatch(raw, /PRIVATE|"box":/, "private keys are stored wrapped");

    // Both servers make keys for a new account at once: the first stored wins, the other adopts it.
    one.tunnel.ensure("c");
    two.tunnel.ensure("c");
    assert.notEqual(one.tunnel.fingerprint("c"), two.tunnel.fingerprint("c"));
    await one.po.provision({ cid: "c", address: "lee@cumuluscloud.app" });
    await two.po.send("a", { to: "lee@cumuluscloud.app", subject: "Welcome", body: "x" }).catch(() => undefined);
    await two.po.view("c");
    assert.equal(two.tunnel.fingerprint("c"), one.tunnel.fingerprint("c"));
    assert.equal((await one.po.view("c")).messages.find((m) => m.folder === "inbox")?.subject, "Welcome");
  });

  test("two copies of a mailbox read from one repository don't remove each other's new messages", async () => {
    const schema = await fresh("copies");
    const repo = new PgMailRepository({ db: pool!, schema });
    const po = new PostOffice({ repository: repo });
    await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    const one = (await repo.mailbox("a"))!;
    const two = (await repo.mailbox("a"))!;
    const msg = (id: string) => ({ id, threadId: id, folder: "inbox" as const, from: { name: "S", email: "s@example.com" }, to: [], cc: [], subject: id, body: "", at: "2026-11-13T00:00:00.000Z", unread: true, starred: false, labels: [] });
    one.messages.unshift(msg("m1"));
    await repo.putMailbox(one);
    two.messages.unshift(msg("m2"));
    await repo.putMailbox(two);
    const ids = (await pool!.query(`SELECT id FROM "${schema}".mail_messages ORDER BY id`)).rows.map((r) => r.id);
    assert.deepEqual(ids, ["m1", "m2"]);
  });

  test("one row per message: a write touches only what changed", async () => {
    const schema = await fresh("messages");
    let statements: string[] = [];
    const db: MailQueryable = { query: (text, params) => { statements.push(text); return pool!.query(text, params); } };
    const po = new PostOffice({ repository: new PgMailRepository({ db, schema }) });
    await po.provision({ cid: "a", address: "alex@cumuluscloud.app" });
    await po.provision({ cid: "b", address: "sam@cumuluscloud.app" });
    for (let i = 0; i < 5; i++) await po.send("a", { to: "sam@cumuluscloud.app", subject: `Note ${i}`, body: "x" });
    const rowsOf = async (cid: string) => (await pool!.query(`SELECT id FROM "${schema}".mail_messages WHERE cid = $1 ORDER BY ord DESC`, [cid])).rows.map((r) => r.id);
    assert.equal((await rowsOf("b")).length, 5);

    const writes = () => statements.filter((t) => /INSERT INTO "[^"]+"\.mail_messages/.test(t)).length;
    statements = [];
    await po.send("a", { to: "sam@cumuluscloud.app", subject: "One more", body: "x" });
    assert.equal(writes(), 2, "one new row in Alex's Sent, one in Sam's inbox; nothing else rewritten");

    const inbox = (await po.view("b")).messages;
    assert.deepEqual(await rowsOf("b"), inbox.map((m) => m.id), "rows come back newest first, as the mailbox lists them");
    statements = [];
    await po.toggleStar("b", inbox[3].id);
    assert.equal(writes(), 1, "starring rewrites one message");

    await po.move("b", inbox[2].id, "trash");
    statements = [];
    await po.remove("b", inbox[2].id);
    assert.equal(writes(), 0);
    assert.equal(statements.filter((t) => /DELETE FROM "[^"]+"\.mail_messages/.test(t)).length, 1);
    assert.deepEqual(await rowsOf("b"), inbox.filter((m) => m.id !== inbox[2].id).map((m) => m.id));
    assert.equal((await new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) }).message("b", inbox[3].id))?.starred, true);
  });

  test("a mailbox saved before messages had rows is read as-is and moved into rows on its next write", async () => {
    const schema = await fresh("legacy");
    const box = {
      cid: "a", owner: { name: "Alex", email: "alex@cumuluscloud.app" }, createdAt: "2026-11-01T00:00:00.000Z", aliases: [], tasks: [], contacts: [],
      messages: [
        { id: "m2", threadId: "m2", folder: "inbox", from: { name: "Sam", email: "sam@example.com" }, to: [], cc: [], subject: "Newer", body: "b", at: "2026-11-02T00:00:00.000Z", unread: true, starred: false, labels: [] },
        { id: "m1", threadId: "m1", folder: "inbox", from: { name: "Sam", email: "sam@example.com" }, to: [], cc: [], subject: "Older", body: "a", at: "2026-11-01T00:00:00.000Z", unread: true, starred: false, labels: [] },
      ],
    };
    await pool!.query(`INSERT INTO "${schema}".mail_mailboxes (cid, data) VALUES ('a', $1)`, [JSON.stringify(box)]);
    await pool!.query(`INSERT INTO "${schema}".mail_addresses (address, cid) VALUES ('alex@cumuluscloud.app', 'a')`);
    const po = new PostOffice({ repository: new PgMailRepository({ db: pool!, schema }) });
    assert.deepEqual((await po.view("a")).messages.map((m) => m.subject), ["Newer", "Older"]);
    await po.markThreadRead("a", "m1");
    const rows = (await pool!.query(`SELECT id FROM "${schema}".mail_messages ORDER BY ord DESC`)).rows.map((r) => r.id);
    assert.deepEqual(rows, ["m2", "m1"]);
    const meta = (await pool!.query(`SELECT data FROM "${schema}".mail_mailboxes`)).rows[0].data;
    assert.equal(meta.messages, undefined, "the mailbox row no longer carries messages");
    assert.deepEqual((await po.view("a")).messages.map((m) => [m.subject, m.unread]), [["Newer", true], ["Older", false]]);
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
