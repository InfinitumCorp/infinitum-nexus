import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  MemoryStore,
  FileStore,
  generateSigner,
  signerFromPrivateKey,
  merkleProof,
  verifyMerkleProof,
  commit,
  verifyCommitment,
} from "./index.ts";
import type { Entry } from "./index.ts";

const grant = (subject: string) => ({
  type: "grant" as const,
  product: "cid",
  actor: subject,
  subject,
  payload: { app: "spectre", scope: ["contacts:read"] },
});

/** A store that lets a test tamper with stored entries, like an attacker with database access. */
class TamperableStore extends MemoryStore {
  raw(): Entry[] {
    return this.items;
  }
}

describe("Firmament ledger", () => {
  it("appends hash-linked, signed entries and verifies them", async () => {
    const signer = generateSigner();
    const ledger = new Ledger(new MemoryStore(), { authorizedSigners: [signer.publicKey] });
    const a = await ledger.append(grant("cid:alex"), signer);
    const b = await ledger.append(grant("cid:sam"), signer);
    assert.equal(a.seq, 0);
    assert.equal(b.prevHash, a.hash);
    assert.deepEqual(await ledger.verify(), { ok: true, length: 2 });
  });

  it("detects an edited entry", async () => {
    const store = new TamperableStore();
    const signer = generateSigner();
    const ledger = new Ledger(store);
    await ledger.append(grant("cid:alex"), signer);
    await ledger.append(grant("cid:sam"), signer);
    store.raw()[0].payload = { app: "spectre", scope: ["contacts:write"] };
    const result = await ledger.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 0);
    assert.equal(result.reason, "entry contents altered");
  });

  it("detects a deleted entry", async () => {
    const store = new TamperableStore();
    const signer = generateSigner();
    const ledger = new Ledger(store);
    for (const s of ["a", "b", "c"]) await ledger.append(grant(`cid:${s}`), signer);
    store.raw().splice(1, 1);
    assert.equal((await ledger.verify()).ok, false);
  });

  it("detects a re-hashed forgery that lacks a valid signature", async () => {
    const store = new TamperableStore();
    const signer = generateSigner();
    const ledger = new Ledger(store);
    await ledger.append(grant("cid:alex"), signer);
    const forged = store.raw()[0];
    forged.signature = generateSigner().sign(forged.hash);
    const result = await ledger.verify();
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid signature");
  });

  it("refuses writers that are not authorized", async () => {
    const trusted = generateSigner();
    const ledger = new Ledger(new MemoryStore(), { authorizedSigners: [trusted.publicKey] });
    await assert.rejects(ledger.append(grant("cid:alex"), generateSigner()), /not authorized/);
  });

  it("queries by subject and type", async () => {
    const signer = generateSigner();
    const ledger = new Ledger();
    await ledger.append(grant("cid:alex"), signer);
    await ledger.append({ ...grant("cid:alex"), type: "revoke" }, signer);
    await ledger.append(grant("cid:sam"), signer);
    assert.equal((await ledger.query({ subject: "cid:alex" })).length, 2);
    assert.equal((await ledger.query({ subject: "cid:alex", type: "revoke" })).length, 1);
  });

  it("produces Merkle inclusion proofs against the anchored root", async () => {
    const signer = generateSigner();
    const ledger = new Ledger();
    for (let i = 0; i < 7; i++) await ledger.append(grant(`cid:${i}`), signer);
    const hashes = (await ledger.entries()).map((e) => e.hash);
    const root = await ledger.root();
    for (let i = 0; i < hashes.length; i++) {
      assert.equal(verifyMerkleProof(hashes[i], merkleProof(hashes, i), root), true);
    }
    assert.equal(verifyMerkleProof(hashes[0], merkleProof(hashes, 1), root), false);
  });

  it("persists to an append-only file and survives a restart", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "firmament-")), "ledger.jsonl");
    const signer = generateSigner();
    const first = new Ledger(new FileStore(path));
    await first.append(grant("cid:alex"), signer);
    await first.append(grant("cid:sam"), signer);

    const restored = signerFromPrivateKey(signer.exportPrivateKey());
    const second = new Ledger(new FileStore(path), { authorizedSigners: [restored.publicKey] });
    await second.append(grant("cid:lee"), restored);
    assert.deepEqual(await second.verify(), { ok: true, length: 3 });
  });

  it("drops a torn last line so the chain still opens", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "firmament-")), "ledger.jsonl");
    const signer = generateSigner();
    const first = new Ledger(new FileStore(path));
    await first.append(grant("cid:alex"), signer);
    await first.append(grant("cid:sam"), signer);
    await appendFile(path, "{\"seq\":2,\"torn\":");

    const second = new Ledger(new FileStore(path));
    assert.deepEqual(await second.verify(), { ok: true, length: 2 });
    const onDisk = await readFile(path, "utf8");
    assert.equal(onDisk.endsWith("\n"), true);
    assert.equal(onDisk.includes("torn"), false);
    await second.append(grant("cid:lee"), signer);
    assert.deepEqual(await second.verify(), { ok: true, length: 3 });
  });

  it("records private data as a commitment, not the data itself", () => {
    const secret = { email: "alex@cumuluscloud.app", phone: "+1 202 555 0100" };
    const { digest, salt } = commit(secret);
    assert.ok(!(digest).includes("alex"));
    assert.equal(verifyCommitment(secret, salt, digest), true);
    assert.equal(verifyCommitment({ ...secret, phone: "x" }, salt, digest), false);
  });
});
