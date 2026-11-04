import { test } from "node:test";
import assert from "node:assert/strict";
import { createPacket } from "./packet.ts";

test("createPacket sets id and observedAt", () => {
  const p = createPacket({
    ownerCid: "cid:user",
    observation: "Damaged sidewalk",
    quality: 0.8,
    permittedUses: ["mapping"],
  });
  assert.ok(p.id.startsWith("pkt_"));
  assert.ok(p.observedAt);
  assert.equal(p.observation, "Damaged sidewalk");
});
