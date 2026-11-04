import { test } from "node:test";
import assert from "node:assert/strict";
import { PersonalSilo } from "./silo.ts";
import { createPacket } from "./packet.ts";

test("PersonalSilo stores and lists by owner", () => {
  const silo = new PersonalSilo();
  const p = createPacket({
    ownerCid: "cid:user",
    observation: "test",
    quality: 0.9,
    permittedUses: ["mapping"],
  });
  silo.put(p);
  assert.equal(silo.get(p.id)?.id, p.id);
  assert.equal(silo.list("cid:user").length, 1);
  assert.equal(silo.list("cid:other").length, 0);
});
