import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { LabyrinthStorage, Organization } from "./model.ts";

/** AES-256-GCM, separate key per client org; keys never enter the snapshot. Single-process writer. */
export class EncryptedFileStorage implements LabyrinthStorage {
  readonly #path: string;
  readonly #key: (orgId: string) => Uint8Array;
  constructor(path: string, keyForOrg: (orgId: string) => Uint8Array) { this.#path = path; this.#key = keyForOrg; }
  #getKey(orgId: string) {
    const key = this.#key(orgId);
    if (key.byteLength !== 32) throw new Error("Labyrinth requires a 32-byte per-organization key");
    return key;
  }
  load(): Organization[] {
    if (!existsSync(this.#path)) return [];
    const file = JSON.parse(readFileSync(this.#path, "utf8"));
    if (file.version !== 1 || !Array.isArray(file.organizations)) throw new Error("Unsupported Labyrinth snapshot");
    const ids = new Set<string>();
    return file.organizations.map((row: { id: string; nonce: string; tag: string; ciphertext: string }) => {
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
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, organizations }), { mode: 0o600, flag: "wx", flush: true });
      renameSync(temp, this.#path);
    } finally { rmSync(temp, { force: true }); }
  }
}
