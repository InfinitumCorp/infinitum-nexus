import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FabricIdentity } from "./auth.ts";
import { FabricService, FabricServiceError, touchUser } from "./service.ts";
import { FabricStore } from "./store.ts";

function person(sub: string, username: string): FabricIdentity {
  return { sub, issuer: "https://id.cumuluscloud.app/realms/cumulus", username, email: null, name: username, expiresAt: 0 };
}

test("sessions persist ciphertext and reopen with the same master key", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-store-"));
  const path = join(dir, "fabric.sqlite");
  const key = randomBytes(32);
  const phrase = `sealed-phrase-${randomBytes(8).toString("hex")}`;
  try {
    let store = new FabricStore(path);
    let service = new FabricService(store, key);
    const alice = person("11111111-1111-4111-8111-111111111111", "alice");
    const bob = person("22222222-2222-4222-8222-222222222222", "bob");
    const cara = person("33333333-3333-4333-8333-333333333333", "cara");
    touchUser(store, alice);
    touchUser(store, bob);
    touchUser(store, cara);
    const created = service.openSession(alice, "Bob");
    const mirrored = service.openSession(bob, "alice");
    assert.equal(mirrored.id, created.id);
    const sent = service.send(alice, created.id, phrase);
    assert.equal(sent.text, phrase);
    assert.equal(service.receive(bob, created.id)[0]?.text, phrase);
    assert.throws(() => service.receive(cara, created.id), (error: FabricServiceError) => error.status === 404);
    store.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      const file = path + suffix;
      if (existsSync(file)) assert.equal(readFileSync(file).includes(phrase), false);
    }

    store = new FabricStore(path);
    service = new FabricService(store, key);
    assert.equal(service.receive(alice, created.id)[0]?.text, phrase);
    store.replaceCiphertext(sent.id, Buffer.from("tampered").toString("base64"));
    assert.equal(service.receive(bob, created.id)[0]?.unreadable, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
