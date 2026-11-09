import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "../../event-ingest/src/testing.ts";
import { MemoryStorage } from "./model.ts";
test("authorized storage snapshot exposes actual enforced org quota, not contents/identities", async () => {
  const storage = new MemoryStorage(),
    s = await setup(storage),
    client = s.auth.forSession(s.owner.token);
  const before = storage.load()[0]!,
    usage = client.usage();
  assert.equal(usage.snapshotBytes, Buffer.byteLength(JSON.stringify(before)));
  assert.ok(usage.orgLimitBytes > usage.snapshotBytes);
  assert.equal(usage.repositories, 1);
  assert.ok(Object.values(usage).every((v) => typeof v === "number"));
  s.setPaid(false);
  assert.throws(() => client.usage());
});
