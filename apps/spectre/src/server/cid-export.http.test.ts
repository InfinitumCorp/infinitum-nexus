import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { base32Decode, hotp } from "@infinitum/cid";
import { harness } from "./test-harness.ts";

const EXPORT_KEY = "test-export-key-".padEnd(48, "e");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// A registered product origin: the rest of the API answers it with CORS headers.
const PRODUCT_ORIGIN = "https://mail.cumuluscloud.app";

test("the account export stays off without a configured key", async () => {
  const h = await harness();
  try {
    const res = await h.call("POST", "/api/id/export", {}, undefined, { "x-cid-export-key": EXPORT_KEY });
    assert.equal(res.status, 404);
  } finally {
    await h.close();
  }
});

test("POST /api/id/export returns accounts for migration and nothing a session could be rebuilt from", async () => {
  const h = await harness({ cidExportKeySha256: sha256(EXPORT_KEY) });
  try {
    const ada = await h.signUp("ada-export");
    const bob = await h.signUp("bob-export");
    const cid = h.suite.cid;

    // Ada confirms an authenticator app; Bob only starts enrolling, so his secret must not leave.
    const adaTotp = cid.enrollTotp(ada.cid);
    const step = Math.floor(Date.now() / 30_000);
    await cid.confirmTotp(ada.cid, hotp(Buffer.from(base32Decode(adaTotp.secret)), step));
    cid.enrollTotp(bob.cid);
    // A linked Google account (the provider round trip is covered in id-provider.http.test.ts).
    const adaAccount = cid.store.accounts.get(ada.cid)!;
    adaAccount.identities = [{ provider: "google", subject: "g-123", email: "ada@gmail.example", linkedAt: "2026-11-05T09:00:00.000Z" }];
    cid.store.byIdentity.set("google|g-123", ada.cid);
    // A pending sign-in challenge exists right now; it must not be exported.
    const pending = await h.call("POST", "/api/auth/signin", {});
    assert.equal(pending.status, 200);

    // Refused without the key or with the wrong key, and never readable by a browser.
    const wrong: Record<string, string>[] = [{}, { "x-cid-export-key": "w".repeat(48) }, { "x-cid-export-key": "short" }];
    for (const headers of wrong) {
      const refused = await h.call("POST", "/api/id/export", {}, undefined, { origin: PRODUCT_ORIGIN, ...headers });
      assert.equal(refused.status, 401);
      assert.equal(refused.headers.get("access-control-allow-origin"), null);
    }
    // A signed-in console cookie is not a substitute for the key.
    assert.equal((await h.call("POST", "/api/id/export", {}, ada.cookie, { "x-spectre": "1" })).status, 401);

    const res = await h.call("POST", "/api/id/export", {}, undefined, { origin: PRODUCT_ORIGIN, "x-cid-export-key": EXPORT_KEY });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
    assert.equal(res.headers.get("cache-control"), "no-store");

    const out = res.body;
    assert.equal(out.format, "cumulus-id.export");
    assert.equal(out.version, 1);
    assert.equal(out.issuer, cid.issuer);
    assert.deepEqual(out.counts, { accounts: 2, authenticators: 2, identities: 1, grants: 2 });
    assert.deepEqual(out.accounts.map((a: { cid: string }) => a.cid).sort(), [ada.cid, bob.cid].sort());
    assert.match(ada.cid, /^cid_[0-9a-f-]{36}$/);

    const a = out.accounts.find((x: { cid: string }) => x.cid === ada.cid);
    assert.deepEqual(Object.keys(a).sort(), ["authenticators", "cid", "createdAt", "federated", "grants", "handle", "identities", "mailAddress", "orgId", "totp", "username"]);
    assert.equal(a.username, "ada-export");
    assert.equal(a.mailAddress, adaAccount.mailAddress);
    assert.equal(a.handle, adaAccount.handle);
    assert.equal(a.createdAt, adaAccount.createdAt);
    assert.equal(a.orgId, null);
    assert.equal(a.federated, null);
    assert.deepEqual(a.totp, { secret: adaTotp.secret, lastStep: adaAccount.totp!.lastStep });
    assert.deepEqual(a.identities, [{ provider: "google", subject: "g-123", email: "ada@gmail.example", linkedAt: "2026-11-05T09:00:00.000Z" }]);

    assert.equal(a.authenticators.length, 1);
    const stored = [...cid.store.authenticators.values()].find((x) => x.cid === ada.cid)!;
    const key = a.authenticators[0];
    assert.deepEqual(Object.keys(key).sort(), ["addedAt", "alg", "backedUp", "credentialId", "id", "kind", "label", "lastUsedAt", "publicKeyCose", "signCount"]);
    assert.equal(key.credentialId, stored.credentialId);
    assert.equal(key.publicKeyCose, stored.publicKeyCose);
    assert.equal(key.alg, -7); // the virtual authenticator makes ES256 passkeys
    assert.equal(key.signCount, stored.signCount);
    assert.equal(key.lastUsedAt, stored.lastUsedAt ?? null);

    assert.equal(a.grants.length, 1);
    assert.equal(a.grants[0].app, "spectre");
    assert.ok(a.grants[0].scopes.includes("crm:read"));
    assert.equal(typeof a.grants[0].grantedAt, "string");

    const b = out.accounts.find((x: { cid: string }) => x.cid === bob.cid);
    assert.equal(b.totp, null); // enrolment never confirmed
    assert.deepEqual(b.identities, []);

    // Nothing a session, a sign-in in progress or an OAuth flow could be rebuilt from.
    const text = JSON.stringify(out);
    for (const s of cid.store.sessions.values()) {
      assert.ok(!text.includes(s.tokenHash), "session token hash leaked");
      assert.ok(!text.includes(s.id), "session id leaked");
    }
    for (const value of cid.store.challenges.keys()) assert.ok(!text.includes(value), "challenge leaked");
    assert.ok(cid.store.challenges.size > 0);
    for (const cookie of [ada.cookie, bob.cookie]) assert.ok(!text.includes(cookie.split("=")[1]!), "session token leaked");
    for (const field of ["tokenHash", "sessions", "challenges", "pendingMfa", "oauthPending", "deviceHandoffs", "entitlements"]) {
      assert.ok(!text.includes(`"${field}"`), `${field} leaked`);
    }
  } finally {
    await h.close();
  }
});
