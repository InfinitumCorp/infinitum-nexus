import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "@infinitum/firmament";
import { createPacket } from "./packet.ts";
import { recordPacket } from "./provenance.ts";

test("recordPacket keeps contact details out of the ledger", async () => {
  const ledger = new Ledger();
  const recorded = await recordPacket(ledger, createPacket({
    ownerCid: "cid:user",
    observation: "Email alice@example.com about the count",
    location: "Call (555) 123-4567",
    quality: 0.8,
    permittedUses: ["mapping"],
  }));
  assert.equal(recorded.observation.includes("alice@"), false);
  assert.equal(recorded.location?.includes("555"), false);
  const payload = JSON.stringify((await ledger.entries())[0].payload);
  assert.equal(payload.includes("alice@"), false);
  assert.equal(payload.includes("555"), false);
  assert.equal((await ledger.verify()).ok, true);
});
