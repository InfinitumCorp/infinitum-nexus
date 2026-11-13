/** CUMULUS_STORE=postgres on a single server (main.ts, the Russia issuer). Needs CID_TEST_PG_URL. */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidStore } from "@infinitum/cid";
import { emptyCumulusStores, saveCumulusStores } from "@infinitum/cumulus";
import { localCidStorage } from "./local-cid.ts";

describe("localCidStorage", () => {
  it("keeps cid.json unless told otherwise, and refuses modes a single server can't run", async () => {
    const s = await localCidStorage(new CidStore(), {});
    assert.equal(s.repository, undefined);
    assert.deepEqual(s.skipFiles, []);
    await assert.rejects(localCidStorage(new CidStore(), { CUMULUS_STORE: "gateway" }), /"document" or "postgres" on a single server/);
    await assert.rejects(localCidStorage(new CidStore(), { CUMULUS_STORE: "postgres" }), /needs CID_DATABASE_URL/);
  });

  const url = process.env.CID_TEST_PG_URL;
  it("copies cid.json into Postgres once, verified, and leaves the file as the rollback copy", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
    const schema = `cid_local_test_${process.pid}`;
    const { default: pg } = await import("pg");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const dir = mkdtempSync(join(tmpdir(), "cid-local-"));
    after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    });

    // Today's server: a document-mode CidService whose store is written to cid.json.
    const signer = generateSigner();
    const stores = emptyCumulusStores();
    const docCid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: ["http://localhost"], store: stores.cid });
    const ivan = await docCid.createAccount({ username: "ivan" });
    const { token } = await (docCid as any).issueSession(ivan.cid, "browser", "passkey");
    saveCumulusStores(dir, stores);
    const fileBefore = readFileSync(join(dir, "cid.json"), "utf8");

    const env = { CUMULUS_STORE: "postgres", CID_DATABASE_URL: url, CID_DATABASE_SCHEMA: schema };
    const lines: string[] = [];
    const first = await localCidStorage(stores.cid, env, (l) => lines.push(l));
    assert.match(lines.join("\n"), /copied cid.json into Postgres \(1 accounts, 0 keys, 1 sessions, 0 grants\), every row verified/);
    assert.equal(stores.cid.accounts.size, 0, "the in-memory copy is dropped");
    const pgCid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: ["http://localhost"], repository: first.repository });
    assert.equal((await pgCid.authenticate(token))?.account.username, "ivan", "existing sessions keep working");
    await pgCid.createAccount({ username: "olga" });

    // main.ts writes the other stores after each request, but not cid.json any more.
    saveCumulusStores(dir, stores, { skip: first.skipFiles });
    assert.equal(readFileSync(join(dir, "cid.json"), "utf8"), fileBefore, "cid.json untouched");
    assert.ok(existsSync(join(dir, "mail.json")));
    await first.close();

    // A restart doesn't copy again (the rows are the source now).
    const restarted = emptyCumulusStores();
    const lines2: string[] = [];
    const second = await localCidStorage((await import("@infinitum/cumulus")).loadCumulusStores(dir, restarted).cid, env, (l) => lines2.push(l));
    assert.deepEqual(lines2, []);
    assert.deepEqual((await second.repository!.allAccounts()).map((a) => a.username), ["ivan", "olga"]);
    await second.close();
  });

  it("CUMULUS_ROWS on a single server: copies mail, wallet and quota once (mail sealed), runs each request in its own transaction", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
    const schema = `cid_local_rows_${process.pid}`;
    const { default: pg } = await import("pg");
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    const dir = mkdtempSync(join(tmpdir(), "cid-local-rows-"));
    after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    });
    const { createCumulus, loadCumulusStores } = await import("@infinitum/cumulus");
    const { randomBytes } = await import("node:crypto");
    const masterKey = randomBytes(32);
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });

    // Today's server: everything in files, mail sealed at rest.
    const today = createCumulus({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], masterKey });
    const vera = await today.cid.createAccount({ username: "vera" });
    await today.credit(vera.cid, "USDC", "12", "Deposit");
    await today.mail.send(vera.cid, { to: "vera@cumuluscloud.app", subject: "Hello", body: "sealed on disk" });
    saveCumulusStores(dir, today.stores, { tunnel: today.tunnel });

    // The next start with CUMULUS_ROWS.
    const stores = loadCumulusStores(dir, emptyCumulusStores());
    const env = { CUMULUS_STORE: "postgres", CID_DATABASE_URL: url, CID_DATABASE_SCHEMA: schema, CUMULUS_ROWS: "mail,wallet,quota" };
    const lines: string[] = [];
    const storage = await localCidStorage(stores.cid, env, (l) => lines.push(l), { stores, masterKey });
    assert.match(lines.join("\n"), /copied mail, wallet, quota into Postgres .*every row verified/);
    assert.deepEqual(storage.skipFiles.sort(), ["cid", "mail", "quota", "wallet"]);
    const raw = (await admin.query(`SELECT data::text AS raw FROM "${schema}".mail_messages`)).rows.map((r) => r.raw).join("");
    assert.doesNotMatch(raw, /sealed on disk/, "mail sealed in the table");

    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], stores, masterKey, repository: storage.repository, repositories: storage.repositories });
    const tx = storage.transaction!;
    assert.equal((await tx(() => suite.wallets.balances(vera.cid))).USDC, "12");
    assert.equal((await tx(() => suite.mail.view(vera.cid))).messages.find((m) => m.folder === "inbox" && m.subject === "Hello")?.body.startsWith("sealed on disk"), true);

    // A request that fails is rolled back whole: the payment and its mail are not saved.
    const ivy = await tx(() => suite.cid.createAccount({ username: "ivy" }));
    await assert.rejects(tx(async () => {
      await suite.pay(vera.cid, "ivy@cumuluscloud.app", "USDC", "5", "oops");
      throw new Error("handler failed after paying");
    }), /handler failed/);
    assert.equal((await tx(() => suite.wallets.balances(vera.cid))).USDC, "12", "rolled back");
    assert.equal((await tx(() => suite.mail.view(ivy.cid))).messages.some((m) => /sent you/.test(m.subject)), false);

    // Requests run side by side: a slow one doesn't hold up another.
    let slowDone = false;
    const slow = tx(async () => {
      await suite.wallets.balances(ivy.cid);
      await new Promise((r) => setTimeout(r, 400));
      slowDone = true;
    });
    await tx(() => suite.wallets.balances(vera.cid));
    assert.equal(slowDone, false, "the quick request finished while the slow one was still running");
    await slow;
    await storage.close();

    // A restart doesn't copy again.
    const again: string[] = [];
    const restarted = await localCidStorage(loadCumulusStores(dir, emptyCumulusStores()).cid, env, (l) => again.push(l), { stores: loadCumulusStores(dir, emptyCumulusStores()), masterKey });
    assert.deepEqual(again, []);
    await restarted.close();
  });
});
