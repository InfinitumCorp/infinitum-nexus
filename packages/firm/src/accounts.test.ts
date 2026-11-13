import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { WalletAccounts, WalletError, WalletStore, parseAmount, formatAmount, type WalletAccountsOptions } from "./accounts.ts";
import { CopyingWalletRepository, MapWalletRepository } from "./repository.ts";

test("amounts round-trip without floating point", () => {
  assert.equal(formatAmount(parseAmount("0.1") + parseAmount("0.2")), "0.3");
  assert.equal(formatAmount(parseAmount("12")), "12");
  assert.throws(() => parseAmount("-1"), WalletError);
  assert.throws(() => parseAmount("1.1234567"), WalletError);
});

// The same behavior on the in-memory store and on a repository that copies every value in and out
// (as a database does), so nothing depends on mutating a wallet that was read.
for (const [name, repository] of [
  ["in-memory store", (s: WalletStore) => new MapWalletRepository(s)],
  ["copying repository", (s: WalletStore) => new CopyingWalletRepository(s)],
] as const) {
  describe(`FIRM Wallet on the ${name}`, () => {
    const make = (opts: WalletAccountsOptions = {}) => {
      const store = new WalletStore();
      return new WalletAccounts({ ...opts, store, repository: repository(store) });
    };

    test("every CID wallet opens once and transfers are all-or-nothing", async () => {
      const recorded: string[] = [];
      const wallets = make({ record: (t) => { recorded.push(t.id); return "hash-" + t.id; } });
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
      const wallets = make({
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
