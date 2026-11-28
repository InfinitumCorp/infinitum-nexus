import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { generateMasterKey, parseMasterKey, sealMailStore, type CumulusTunnel } from "@infinitum/mail";
import { dirname, join } from "node:path";
import type { CumulusStores } from "./suite.ts";

/**
 * Snapshot persistence for stores made of Maps (same format as +SPCTR's). Writes are atomic
 * (temp file + rename). Hosted deployments use the nexus-store gateway instead.
 */

export function toSnapshot(store: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store as Record<string, unknown>)) out[k] = v instanceof Map ? { __map: [...v.entries()] } : v;
  return out;
}

export function applySnapshot<T extends object>(target: T, data: Record<string, unknown>): T {
  const t = target as Record<string, unknown>;
  for (const v of Object.values(t)) if (v instanceof Map) v.clear();
  for (const [k, v] of Object.entries(data)) {
    const value = v as { __map?: [unknown, unknown][] };
    if (value && Array.isArray(value.__map)) {
      const existing = t[k];
      if (existing instanceof Map) for (const [mk, mv] of value.__map) existing.set(mk, mv);
      else t[k] = new Map(value.__map);
    } else t[k] = v;
  }
  return target;
}

export function saveSnapshot(path: string, store: object) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(toSnapshot(store)));
  renameSync(tmp, path);
}

export function loadSnapshot<T extends object>(path: string, target: T): T {
  if (!existsSync(path)) return target;
  return applySnapshot(target, JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
}

/** Load every suite store from `dir` (cid.json, mail.json, wallet.json, quota.json, suite.json, tunnel.json). */
export function loadCumulusStores(dir: string, stores: CumulusStores): CumulusStores {
  for (const [name, store] of Object.entries(stores)) loadSnapshot(join(dir, `${name}.json`), store);
  return stores;
}

/**
 * Write every suite store to `dir`. Pass the suite's tunnel and, when it has a persistent master key,
 * mailboxes are written sealed (subjects, bodies and files encrypted to each owner) and the wrapped
 * account keys go to tunnel.json. Without a persistent key, tunnel keys aren't written at all.
 */
export function saveCumulusStores(dir: string, stores: CumulusStores, opts: { tunnel?: CumulusTunnel; skip?: string[] } = {}) {
  const sealing = opts.tunnel?.persistent ? opts.tunnel : undefined;
  for (const [name, store] of Object.entries(stores)) {
    if (name === "tunnel" && !sealing) continue;
    if (opts.skip?.includes(name)) continue; // kept elsewhere (e.g. Cumulus://ID in Postgres); leave its file as it was
    saveSnapshot(join(dir, `${name}.json`), name === "mail" && sealing ? sealMailStore(stores.mail, sealing) : store);
  }
}

/**
 * The Cumulus Tunnel master key: CUMULUS_MAIL_MASTER_KEY (base64, 32 bytes) when set, otherwise a key
 * file in `dir` created on first run (owner-only permissions). In production, set the variable from a
 * secrets manager and keep it out of the data directory.
 */
export function loadOrCreateMasterKey(dir: string, env: Record<string, string | undefined> = process.env): Buffer {
  if (env.CUMULUS_MAIL_MASTER_KEY) return parseMasterKey(env.CUMULUS_MAIL_MASTER_KEY);
  const file = join(dir, "tunnel-master.key");
  if (existsSync(file)) return parseMasterKey(readFileSync(file, "utf8"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, generateMasterKey(), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
  return parseMasterKey(readFileSync(file, "utf8"));
}
