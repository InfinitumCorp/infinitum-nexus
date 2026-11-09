import { MAX_SNAPSHOT_FILE_BYTES } from "./limits.ts";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, openSync, closeSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { LabyrinthStorage, Organization } from "./model.ts";

/** AES-256-GCM, separate key per client org; keys never enter the snapshot. Atomic snapshot CAS with one active service writer. */
export class EncryptedFileStorage implements LabyrinthStorage {
  readonly #path: string;
  readonly #key: (orgId: string) => Uint8Array;
  #revision: string | null = null;
  #digest(raw: string) { return createHash("sha256").update(raw).digest("hex"); }
  constructor(path: string, keyForOrg: (orgId: string) => Uint8Array) { this.#path = path; this.#key = keyForOrg; }
  #getKey(orgId: string) {
    const key = this.#key(orgId);
    if (key.byteLength !== 32) throw new Error("Labyrinth requires a 32-byte per-organization key");
    return key;
  }
  #readSnapshot(): string {
    if (statSync(this.#path).size > MAX_SNAPSHOT_FILE_BYTES) throw new Error("Labyrinth encrypted snapshot exceeds capacity");
    return readFileSync(this.#path, "utf8");
  }
  load(): Organization[] {
    if (!existsSync(this.#path)) { this.#revision = null; return []; }
    const raw = this.#readSnapshot();
    const file = JSON.parse(raw);
    if (file.version !== 1 || !Array.isArray(file.organizations)) throw new Error("Unsupported Labyrinth snapshot");
    const ids = new Set<string>();
    const orgs = file.organizations.map((row: { id: string; nonce: string; tag: string; ciphertext: string }) => {
      if (typeof row.id !== "string" || ids.has(row.id)) throw new Error("Invalid organization manifest");
      ids.add(row.id);
      const nonce = Buffer.from(row.nonce, "base64");
      const tag = Buffer.from(row.tag, "base64");
      if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encryption envelope");
      const decipher = createDecipheriv("aes-256-gcm", this.#getKey(row.id), nonce);
      decipher.setAAD(Buffer.from(`LBRNTH:1:${row.id}`));
      decipher.setAuthTag(tag);
      const org = JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8")) as Organization;
      if (org.id !== row.id) throw new Error("Organization mismatch");
      return org;
    });
    this.#revision = this.#digest(raw);
    return orgs;
  }
  save(orgs: Organization[]): void {
    const organizations = orgs.map(org => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.#getKey(org.id), nonce);
      cipher.setAAD(Buffer.from(`LBRNTH:1:${org.id}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(org), "utf8"), cipher.final()]);
      return { id: org.id, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
    });
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.${randomUUID()}.tmp`;
    const raw = JSON.stringify({ version: 1, organizations });
    const revision = this.#digest(raw);
    if (Buffer.byteLength(raw) > MAX_SNAPSHOT_FILE_BYTES) throw new Error("Labyrinth encrypted snapshot exceeds capacity");
    // Exclusive file creation serializes cooperating writers, including separate processes.
    // A crashed writer leaves its lock: fail closed; the operator must verify/remove it.
    const lock = `${this.#path}.lock`;
    const fd = openSync(lock, "wx", 0o600);
    try {
      const current = existsSync(this.#path) ? this.#digest(this.#readSnapshot()) : null;
      if (current !== this.#revision) throw new Error("Labyrinth snapshot changed; reload the service before retrying (stale writer conflict)");
      writeFileSync(temp, raw, { mode: 0o600, flag: "wx", flush: true });
      renameSync(temp, this.#path);
      this.#revision = revision;
    } finally {
      // Cleanup must not turn a committed atomic replacement into a reported failure.
      // A lock that cannot be removed leaves subsequent writes fail-closed.
      for (const cleanup of [() => closeSync(fd), () => rmSync(temp, { force: true }), () => rmSync(lock)]) {
        try { cleanup(); } catch { /* Operator intervention required if a stale lock remains. */ }
      }
    }
  }
}
