import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidStore, hotp, base32Decode } from "./index.ts";
import { cidSecretKeyFromEnv, deriveCidSecretKey, secretBox } from "./secret-box.ts";
import { exportCidAccounts } from "./account-export.ts";

const START = new Date("2026-11-12T12:00:00Z");

function service(key?: Buffer, store = new CidStore()) {
  const signer = generateSigner();
  let now = START;
  const cid = new CidService({
    ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "id.example", origins: ["https://id.example"],
    clock: () => now, store, ...(key ? { secretKey: key } : {}),
  });
  return { cid, store, tick: () => (now = new Date(now.getTime() + 30_000)), now: () => now };
}
const code = (secret: string, at: Date) => hotp(base32Decode(secret), Math.floor(at.getTime() / 30_000));

describe("secretBox", () => {
  it("round-trips, binds the value to its account, and refuses tampering", () => {
    const box = secretBox(randomBytes(32));
    const sealed = box.seal("JBSWY3DPEHPK3PXP", "cid_a");
    assert.match(sealed, /^sealed:v1:/);
    assert.ok(!sealed.includes("JBSWY3DP"));
    assert.equal(box.open(sealed, "cid_a"), "JBSWY3DPEHPK3PXP");
    assert.throws(() => box.open(sealed, "cid_b"), "copied onto another account it doesn't open");
    const bytes = Buffer.from(sealed.slice("sealed:v1:".length), "base64url");
    bytes[bytes.length - 1] ^= 1;
    assert.throws(() => box.open(`sealed:v1:${bytes.toString("base64url")}`, "cid_a"));
    assert.throws(() => secretBox(randomBytes(16)), /32 bytes/);
  });

  it("reads the key from CID_SECRET_KEY, or derives one from a master key", () => {
    const key = randomBytes(32);
    assert.deepEqual(cidSecretKeyFromEnv({ CID_SECRET_KEY: key.toString("base64") }), key);
    assert.deepEqual(cidSecretKeyFromEnv({ CID_SECRET_KEY: key.toString("base64url") }), key);
    assert.equal(cidSecretKeyFromEnv({}), undefined);
    assert.throws(() => cidSecretKeyFromEnv({ CID_SECRET_KEY: "c2hvcnQ=" }), /32 bytes/);
    const master = randomBytes(32);
    assert.deepEqual(deriveCidSecretKey(master), deriveCidSecretKey(master));
    assert.notDeepEqual(deriveCidSecretKey(master), master);
  });
});

describe("CidService with a secret key", () => {
  it("never stores the authenticator-app seed in the clear, and codes still work end to end", async () => {
    const { cid, store, now, tick } = service(randomBytes(32));
    const account = await cid.createAccount({ username: "alex" });
    const { secret, uri } = await cid.enrollTotp(account.cid);
    assert.match(uri, new RegExp(`secret=${secret}`), "the person still gets the real seed to scan once");
    const stored = () => store.accounts.get(account.cid)!.totp!.secret;
    assert.match(stored(), /^sealed:v1:/);
    assert.ok(!JSON.stringify([...store.accounts.values()]).includes(secret), "not anywhere in the saved account");
    await cid.confirmTotp(account.cid, code(secret, now()));
    tick();
    await assert.rejects(cid.disableTotp(account.cid, "000000"), /didn't match/);
    assert.equal((await exportCidAccounts(cid)).accounts[0]!.totp!.secret, secret, "the account export still carries the real seed");
    await cid.disableTotp(account.cid, code(secret, now()));
    assert.equal(store.accounts.get(account.cid)!.totp, undefined);
  });

  it("seals a seed saved before the key was set, the next time it is used", async () => {
    const before = service();
    const account = await before.cid.createAccount({ username: "sam" });
    const { secret } = await before.cid.enrollTotp(account.cid);
    assert.equal(before.store.accounts.get(account.cid)!.totp!.secret, secret, "no key: stored as before");

    const after = service(randomBytes(32), before.store);
    await after.cid.confirmTotp(account.cid, code(secret, after.now()));
    assert.match(before.store.accounts.get(account.cid)!.totp!.secret, /^sealed:v1:/);
  });

  it("says so, instead of failing codes silently, if the key goes missing", async () => {
    const sealedSide = service(randomBytes(32));
    const account = await sealedSide.cid.createAccount({ username: "kim" });
    const { secret } = await sealedSide.cid.enrollTotp(account.cid);
    const keyless = service(undefined, sealedSide.store);
    await assert.rejects(keyless.cid.confirmTotp(account.cid, code(secret, keyless.now())), /no CID secret key is configured/);
  });
});
