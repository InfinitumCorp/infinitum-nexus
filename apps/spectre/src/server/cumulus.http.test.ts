import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";

test("signing up in +SPCTR creates the whole Cumulus account: Mail, Cloud storage and a FIRM Wallet", async () => {
  const h = await harness();
  try {
    const { cookie, cid } = await h.signUp("mira");
    const me = await h.call("GET", "/api/me", undefined, cookie);
    assert.equal(me.status, 200);
    assert.equal(me.body.mailAddress, "mira@cumuluscloud.app");
    assert.equal(me.body.cumulus.plan, "Free");
    assert.equal(me.body.cumulus.mail.unread, 1, "the welcome message");
    assert.match(me.body.cumulus.wallet.address, /^0x[0-9a-f]{40}$/);
    assert.match(me.body.cumulus.storage.label, /of 15 GB/);
    assert.equal(await h.suite.mail.resolve("mira@cumuluscloud.app"), cid);
  } finally {
    await h.close();
  }
});
