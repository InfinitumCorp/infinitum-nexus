/** CUMULUS_STORE: where hosted products keep Cumulus://ID (relational storage phase 4). */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { migrateCid } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores } from "@infinitum/cumulus";
import { cidStorageFromEnv } from "./cid-store.ts";
import { MemoryGateway, RemoteState } from "./remote.ts";

describe("cidStorageFromEnv", () => {
  it("keeps today's document path unless told otherwise", () => {
    assert.deepEqual(cidStorageFromEnv({}), { inDocuments: true });
    assert.deepEqual(cidStorageFromEnv({ CUMULUS_STORE: "document" }), { inDocuments: true });
  });

  it("refuses an unknown mode, and Postgres without a database", () => {
    assert.throws(() => cidStorageFromEnv({ CUMULUS_STORE: "mysql" }), /must be "document" or "postgres"/);
    assert.throws(() => cidStorageFromEnv({ CUMULUS_STORE: "postgres" }), /needs CID_DATABASE_URL/);
  });

  const url = process.env.CID_TEST_PG_URL;
  it("CUMULUS_STORE=postgres: accounts become rows and the cid document is no longer saved", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
    const schema = `cid_store_test_${process.pid}`;
    const { default: pg } = await import("pg");
    const admin = new pg.Pool({ connectionString: url, max: 2 });
    after(async () => {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    });
    await migrateCid(admin, schema);

    const storage = cidStorageFromEnv({ CUMULUS_STORE: "postgres", CID_DATABASE_URL: url, CID_DATABASE_SCHEMA: schema });
    assert.equal(storage.inDocuments, false);
    const gateway = new MemoryGateway();
    const stores = emptyCumulusStores();
    const state = new RemoteState(gateway, { "cumulus-mail": stores.mail, "firm-wallet": stores.wallet });
    state.metricsLog = null;
    state.participants.push(storage.participant!);
    const signer = generateSigner();
    const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
    const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], stores, repository: storage.repository });

    const account = await state.transaction(() => suite.cid.createAccount({ username: "alex" }));
    const { rows } = await admin.query(`SELECT username FROM "${schema}".cid_accounts WHERE cid = $1`, [account.cid]);
    assert.deepEqual(rows, [{ username: "alex" }]);
    assert.equal(gateway.docs.has("cid"), false, "the cid document isn't written any more");
    assert.equal(stores.cid.accounts.size, 0, "nothing reads the in-memory store");
    assert.ok(gateway.docs.has("cumulus-mail"), "the new account still got its mailbox");
    assert.equal(await state.transaction(() => suite.provisionAll()), 0, "provisioning finds the account in Postgres");
    // A fresh instance (another server) signs the same person in from the rows.
    const again = cidStorageFromEnv({ CUMULUS_STORE: "postgres", CID_DATABASE_URL: url, CID_DATABASE_SCHEMA: schema });
    assert.equal(await again.repository!.cidForUsername("alex"), account.cid);
  });
});
