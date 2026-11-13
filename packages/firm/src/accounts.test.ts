import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { WalletAccounts, WalletError, WalletStore, parseAmount, formatAmount, type WalletAccountsOptions } from "./accounts.ts";
import { CopyingWalletRepository, MapWalletRepository, type WalletRepository } from "./repository.ts";
import { PgWalletRepository, migrateWallet } from "./postgres.ts";

// CID_TEST_PG_URL (the PostgreSQL CI job sets it) adds a run on PgWalletRepository, a fresh schema each time.
const pgUrl = process.env.CID_TEST_PG_URL;
const pgPool = pgUrl ? new (await import("pg")).default.Pool({ connectionString: pgUrl, max: 6 }) : null;
const pgSchemas: string[] = [];
after(async () => {
  for (const s of pgSchemas) await pgPool!.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pgPool?.end();
});
async function pgRepository(): Promise<PgWalletRepository> {
  const schema = `wallet_test_${process.pid}_${pgSchemas.length}`;
  pgSchemas.push(schema);
  await migrateWallet(pgPool!, schema);
  return new PgWalletRepository({ db: pgPool!, schema });
}

test("amounts round-trip without floating point", () => {
  assert.equal(formatAmount(parseAmount("0.1") + parseAmount("0.2")), "0.3");
  assert.equal(formatAmount(parseAmount("12")), "12");
  assert.throws(() => parseAmount("-1"), WalletError);
  assert.throws(() => parseAmount("1.1234567"), WalletError);
});

// The same behavior on the in-memory store and on a repository that copies every value in and out
// (as a database does), so nothing depends on mutating a wallet that was read.
const variants: [string, (s: WalletStore) => Promise<WalletRepository>][] = [
  ["in-memory store", async (s) => new MapWalletRepository(s)],
  ["copying repository", async (s) => new CopyingWalletRepository(s)],
];
if (pgPool) variants.push(["PostgreSQL", () => pgRepository()]);
for (const [name, repository] of variants) {
  describe(`FIRM Wallet on the ${name}`, () => {
    const make = async (opts: WalletAccountsOptions = {}) => {
      const store = new WalletStore();
      return new WalletAccounts({ ...opts, store, repository: await repository(store) });
    };

    test("every CID wallet opens once and transfers are all-or-nothing", async () => {
      const recorded: string[] = [];
      const wallets = await make({ record: (t) => { recorded.push(t.id); return "hash-" + t.id; } });
      const a = await wallets.open("cid:a");
      assert.equal((await wallets.open("cid:a")).address, a.address, "opening again returns the same wallet");
      assert.match(a.address, /^0x[0-9a-f]{40}$/);
      assert.equal(await wallets.cidForAddress(a.address.toUpperCase().replace("0X", "0x")), "cid:a");
      await wallets.open("cid:b");

      await wallets.credit("cid:a", "USDC", "204", "Data Exchange payout");
      const tx = await wallets.transfer("cid:a", "cid:b", "USDC", "4.5", "lunch");
      assert.equal(tx.ledgerHash, "hash-" + tx.id);
      assert.deepEqual(await wallets.balances("cid:a"), { FIRM: "0", USDC: "199.5" });
      assert.deepEqual(await wallets.balances("cid:b"), { FIRM: "0", USDC: "4.5" });

      await assert.rejects(wallets.transfer("cid:b", "cid:a", "USDC", "5"), (e: unknown) => e instanceof WalletError && e.code === "insufficient_funds");
      assert.deepEqual(await wallets.balances("cid:b"), { FIRM: "0", USDC: "4.5" }, "a refused transfer moves nothing");
      await assert.rejects(wallets.transfer("cid:a", "cid:a", "USDC", "1"), WalletError);
      await assert.rejects(wallets.transfer("cid:a", "cid:b", "DOGE", "1"), WalletError);
      await assert.rejects(wallets.transfer("cid:a", "cid:nobody", "USDC", "1"), (e: unknown) => e instanceof WalletError && e.code === "no_wallet");
      assert.equal(recorded.length, 2);
      assert.equal((await wallets.history("cid:b")).length, 1);
      assert.deepEqual((await wallets.history("cid:a")).map((t) => t.memo), ["lunch", "Data Exchange payout"], "newest first");
    });

    test("a ledger failure returns the money and leaves no transfer", async () => {
      let down = false;
      const wallets = await make({
        record: () => {
          if (down) throw new Error("ledger down");
          return "ok";
        },
      });
      await wallets.open("cid:a");
      await wallets.open("cid:b");
      await wallets.credit("cid:a", "USDC", "10", "seed");
      down = true;
      await assert.rejects(wallets.transfer("cid:a", "cid:b", "USDC", "4", "lunch"), /ledger down/);
      assert.deepEqual(await wallets.balances("cid:a"), { FIRM: "0", USDC: "10" });
      assert.deepEqual(await wallets.balances("cid:b"), { FIRM: "0", USDC: "0" });
      assert.equal((await wallets.history("cid:a")).length, 1);
      await assert.rejects(wallets.credit("cid:b", "FIRM", "3", "payout"), /ledger down/);
      assert.deepEqual(await wallets.balances("cid:b"), { FIRM: "0", USDC: "0" });
    });
  });
}

describe("FIRM Wallet on PostgreSQL, two payments at once", { skip: pgPool ? false : "set CID_TEST_PG_URL to run" }, () => {
  test("two transactions spending the same balance: the second waits for the first and is refused", async () => {
    const schema = `wallet_race_${process.pid}`;
    pgSchemas.push(schema);
    await migrateWallet(pgPool!, schema);
    const setup = new WalletAccounts({ repository: new PgWalletRepository({ db: pgPool!, schema }) });
    await setup.open("cid:a");
    await setup.open("cid:b");
    await setup.open("cid:c");
    await setup.credit("cid:a", "USDC", "10", "seed");

    // Two servers, each with its own connection and transaction, both send 7 of the 10. Each waits
    // after reading the sender's wallet until the other has read it too (or 500 ms pass, which is what
    // happens when the row lock makes the second one wait), so the reads really overlap.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const pay = async (to: string) => {
      const client = await pgPool!.connect();
      const db = {
        async query(text: string, params?: unknown[]) {
          const r = await client.query(text, params);
          if (/FROM "[^"]+"\.wallet_accounts WHERE cid = \$1/.test(text) && params?.[0] === "cid:a") {
            if (++arrived === 2) release();
            await Promise.race([bothRead, new Promise((r) => setTimeout(r, 500))]);
          }
          return r;
        },
      };
      try {
        await client.query("BEGIN");
        const wallets = new WalletAccounts({ repository: new PgWalletRepository({ db, schema }) });
        await wallets.transfer("cid:a", to, "USDC", "7", "race");
        await client.query("COMMIT");
        return "sent";
      } catch (err) {
        await client.query("ROLLBACK");
        return (err as { code?: string }).code ?? String(err);
      } finally {
        client.release();
      }
    };
    const outcomes = (await Promise.all([pay("cid:b"), pay("cid:c")])).sort();
    assert.deepEqual(outcomes, ["insufficient_funds", "sent"]);
    assert.deepEqual(await setup.balances("cid:a"), { FIRM: "0", USDC: "3" }, "never spent twice");
  });
});

