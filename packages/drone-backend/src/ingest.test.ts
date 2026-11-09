import {test} from "node:test";
import assert from "node:assert/strict";
import {droneArchiveEvent} from "./ingest.ts";
import {frame} from "./fixtures.ts";
test("drone archive DTO contains selected observations, never control authority",()=>{
  const event=droneArchiveEvent("selected-log",frame());assert.equal(event.kind,"archive");
  const payload=event.payload as Record<string,unknown>;assert.equal(payload.controlAuthority,false);assert.equal(payload.senderVerified,false);assert.ok(Array.isArray(payload.observations));
  assert.throws(()=>droneArchiveEvent("../escape",frame()));assert.throws(()=>droneArchiveEvent("bad",Buffer.from([1])));
});
