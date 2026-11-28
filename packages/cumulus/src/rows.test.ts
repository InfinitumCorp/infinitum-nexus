/**
 * Mail, Wallet and Quota moved from the in-memory stores (their documents) into Postgres rows: the
 * backfill copies and verifies, and a suite running on the rows sees the same mail, balances and
 * storage, and keeps working. Runs when CID_TEST_PG_URL is set.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCumulusStores } from "./persist.ts";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "./index.ts";
import { backfillProductRows, parseRowProducts, productRepositories } from "./rows.ts";

describe("CUMULUS_ROWS parsing", () => {
  it("accepts the products and refuses anything else", () => {
    assert.deepEqual(parseRowProducts(" Mail, wallet,quota ,mail"), ["mail", "wallet", "quota"]);
    assert.deepEqual(parseRowProducts(undefined), []);
    assert.throws(() => parseRowProducts("mail,cid"), /unknown product "cid"/);
  });
});

const url = process.env.CID_TEST_PG_URL;
const { default: pg } = url ? await import("pg") : { default: undefined as never };
const pool = url ? new pg.Pool({ connectionString: url, max: 4, allowExitOnIdle: true }) : undefined;
pool?.on("error", () => {});
const schema = `cumulus_rows_${process.pid}`;
after(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

describe("Mail, Wallet and Quota on Postgres rows", { skip: url ? false : "set CID_TEST_PG_URL to run" }, () => {
  it("backfills from the documents, and a suite on the rows carries on where they left off", async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const masterKey = randomBytes(32);
    const base = { ledger, signer, rpId: "id.cumuluscloud.app", origins: ["https://id.cumuluscloud.app"], masterKey };

    // Today: everything in the in-memory stores (what the documents hold).
    const before = createCumulus(base);
    const alex = await before.cid.createAccount({ username: "alex" });
    const sam = await before.cid.createAccount({ username: "sam" });
    await before.credit(alex.cid, "USDC", "50", "Deposit");
    await before.pay(alex.cid, "sam@cumuluscloud.app", "USDC", "5", "Lunch");
    await before.mail.send(alex.cid, { to: "sam@cumuluscloud.app, priya@example.com", subject: "Plans", body: "3pm?" });
    await before.cloud.put("notes.txt", alex.cid, 1_000_000);

    const report = await backfillProductRows({ mail: before.stores.mail, wallet: before.stores.wallet, quota: before.stores.quota }, pool!, { schema, tunnel: before.tunnel });
    assert.deepEqual(report.mismatches, []);
    assert.equal(report.counts.mailboxes, 2);
    assert.equal(report.counts.wallets, 2);
    assert.equal(report.counts.outbound, 1);
    const again = await backfillProductRows({ mail: before.stores.mail, wallet: before.stores.wallet, quota: before.stores.quota }, pool!, { schema, tunnel: before.tunnel });
    assert.deepEqual(again.mismatches, [], "running it twice is safe");

    const raw = (await pool!.query(`SELECT data::text AS raw FROM "${schema}".mail_messages`)).rows.map((r) => r.raw).join("\n");
    assert.doesNotMatch(raw, /3pm\?/, "mail content is sealed in the table");

    // After: a new server, same ID document and master key, Mail/Wallet/Quota on the rows only.
    const after = createCumulus({
      ...base,
      stores: { cid: before.stores.cid },
      repositories: productRepositories(["mail", "wallet", "quota"], pool!, schema),
    });
    assert.equal(after.stores.mail.mailboxes.size, 0, "nothing in the in-memory mail store");
    const view = async (s: typeof before, cid: string) => (await s.mail.view(cid)).messages.map((m) => [m.folder, m.subject, m.body]);
    assert.deepEqual(await view(after, sam.cid), await view(before, sam.cid));
    assert.deepEqual(await after.wallets.balances(alex.cid), await before.wallets.balances(alex.cid));
    assert.deepEqual(await after.quota.usage(alex.cid), await before.quota.usage(alex.cid));
    assert.equal((await after.mail.outboundQueue()).length, 1);

    // And it keeps working on the rows.
    await after.pay(sam.cid, "alex@cumuluscloud.app", "USDC", "2", "Coffee");
    assert.equal((await after.wallets.balances(sam.cid)).USDC, "3");
    assert.ok((await after.mail.view(alex.cid)).messages.some((m) => m.subject.includes("sent you 2 USDC")));
    assert.equal((await before.wallets.balances(sam.cid)).USDC, "5", "the old stores weren't touched");
  });

  it("rows-cli copies a single server's data directory (mail sealed at rest) and verifies it", async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    const masterKey = randomBytes(32);
    const suite = createCumulus({ ledger, signer, rpId: "id.cumuluscloud.app", origins: ["https://id.cumuluscloud.app"], masterKey });
    const lee = await suite.cid.createAccount({ username: "lee" });
    await suite.credit(lee.cid, "USDC", "7", "Deposit");
    await suite.mail.send(lee.cid, { to: "lee@cumuluscloud.app", subject: "Note to self", body: "secret plans" });
    const dir = mkdtempSync(join(tmpdir(), "rows-cli-"));
    try {
      saveCumulusStores(dir, suite.stores, { tunnel: suite.tunnel });
      writeFileSync(join(dir, "tunnel-master.key"), masterKey.toString("base64"), { mode: 0o600 });
      const cliSchema = `${schema}_cli`;
      const env = { ...process.env, CID_DATABASE_URL: url, CUMULUS_MAIL_MASTER_KEY: "" };
      delete (env as Record<string, string | undefined>).CUMULUS_MAIL_MASTER_KEY;
      const run = (...args: string[]) => execFileSync(process.execPath, ["--experimental-strip-types", "src/rows-cli.ts", "--dir", dir, "--schema", cliSchema, ...args], { env, encoding: "utf8" });
      assert.match(run(), /Dry run: nothing written/);
      const out = run("--write");
      assert.match(out, /"mismatches":0/);
      const { rows } = await pool!.query(`SELECT data::text AS raw FROM "${cliSchema}".mail_messages`);
      assert.ok(rows.length >= 2);
      assert.doesNotMatch(rows.map((r) => r.raw).join(""), /secret plans/);
      const wallet = (await pool!.query(`SELECT count(*)::int AS n FROM "${cliSchema}".wallet_accounts`)).rows[0].n;
      assert.equal(wallet, 1);
      await pool!.query(`DROP SCHEMA "${cliSchema}" CASCADE`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
