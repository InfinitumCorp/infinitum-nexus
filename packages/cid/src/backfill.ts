/**
 * Cumulus://ID backfill (relational-storage plan, phase 3): copy the `cid` document that products
 * keep in nexus_docs today into a CidRepository (PgCidRepository), then read every entity back and
 * compare.
 *
 * - checkCidStore: dry run. Finds what the database would refuse (a username, credential id or
 *   session token used twice) and references to things that don't exist. Writes nothing.
 * - backfillCid: upserts everything (safe to run again), then verifies each entity and every lookup
 *   index, and compares one hash over the whole source with one over what the target returns.
 *
 * Single-use items (sign-in challenges, MFA steps, OAuth state, device handoffs) expire within
 * minutes and are not copied; the report counts them.
 */
import { createHash } from "node:crypto";
import { CidStore, type Authenticator, type Grant, type Session } from "./service.ts";
import type { CidRepository } from "./repository.ts";

/** A CidStore from the JSON the document store keeps (Maps as `{ __map: [[k, v], …] }`). */
export function cidStoreFromSnapshot(data: Record<string, unknown>): CidStore {
  const store = new CidStore();
  const t = store as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(data ?? {})) {
    const entries = (v as { __map?: [unknown, unknown][] } | null)?.__map;
    if (Array.isArray(entries) && t[k] instanceof Map) for (const [mk, mv] of entries) (t[k] as Map<unknown, unknown>).set(mk, mv);
  }
  return store;
}

export interface CidCounts {
  accounts: number;
  identities: number;
  federation: number;
  authenticators: number;
  sessions: number;
  grants: number;
  orgs: number;
}

export interface CidCheck {
  counts: CidCounts;
  /** Single-use items left behind on purpose. */
  skippedOneTime: number;
  /** Problems that would make the copy fail or come out different. Empty means safe to write. */
  problems: string[];
}

const counts = (s: CidStore): CidCounts => ({
  accounts: s.accounts.size, identities: s.byIdentity.size, federation: s.byFederation.size,
  authenticators: s.authenticators.size, sessions: s.sessions.size, grants: s.grants.size, orgs: s.orgs.size,
});

/** Dry run: what the database would refuse, and dangling references. Writes nothing. */
export function checkCidStore(s: CidStore): CidCheck {
  const problems: string[] = [];
  const seen = (what: string) => {
    const m = new Map<string, string>();
    return (key: string, owner: string) => {
      const prev = m.get(key);
      if (prev !== undefined && prev !== owner) problems.push(`${what} ${key} is used by both ${prev} and ${owner}`);
      m.set(key, owner);
    };
  };
  const username = seen("username");
  for (const [cid, a] of s.accounts) {
    if (a.cid !== cid) problems.push(`account stored under ${cid} says it is ${a.cid}`);
    username(a.username, a.cid);
    if (s.byUsername.get(a.username) !== a.cid) problems.push(`username index for ${a.username} doesn't point at ${a.cid}`);
    if (a.orgId && !s.orgs.has(a.orgId)) problems.push(`account ${a.cid} belongs to missing org ${a.orgId}`);
  }
  const credential = seen("credential id");
  for (const [id, k] of s.authenticators) {
    if (k.id !== id) problems.push(`authenticator stored under ${id} says it is ${k.id}`);
    credential(k.credentialId, k.id);
    if (!s.accounts.has(k.cid)) problems.push(`authenticator ${k.id} belongs to missing account ${k.cid}`);
  }
  const token = seen("session token hash");
  for (const [id, x] of s.sessions) {
    if (x.id !== id) problems.push(`session stored under ${id} says it is ${x.id}`);
    token(x.tokenHash, x.id);
    if (!s.accounts.has(x.cid)) problems.push(`session ${x.id} belongs to missing account ${x.cid}`);
  }
  for (const [key, g] of s.grants) {
    if (key !== `${g.cid}|${g.app}`) problems.push(`grant stored under ${key} is for ${g.cid}|${g.app}`);
    if (!s.accounts.has(g.cid)) problems.push(`grant ${key} belongs to missing account ${g.cid}`);
  }
  for (const [key, cid] of [...s.byIdentity, ...s.byFederation]) {
    if (!s.accounts.has(cid)) problems.push(`sign-in link ${key} points at missing account ${cid}`);
  }
  const skippedOneTime = s.challenges.size + s.pendingMfa.size + s.oauthPending.size + s.deviceHandoffs.size;
  return { counts: counts(s), skippedOneTime, problems };
}

/** JSON with sorted keys, so the same entity hashes the same whichever side wrote it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface BackfillReport extends CidCheck {
  /** Entities written (upserted). */
  written: number;
  /** Entities or lookups that read back differently. Empty means the copy is exact. */
  mismatches: string[];
  sourceHash: string;
  targetHash: string;
}

/**
 * Copy `source` into `target` and verify it. Refuses to write when the dry-run check finds problems.
 * `onProgress` gets a line every 500 entities.
 */
export async function backfillCid(source: CidStore, target: CidRepository, options: { onProgress?: (line: string) => void } = {}): Promise<BackfillReport> {
  const check = checkCidStore(source);
  if (check.problems.length) throw new Error(`Not writing: ${check.problems.length} problem(s), first: ${check.problems[0]}`);
  let written = 0;
  const tick = () => {
    if (++written % 500 === 0) options.onProgress?.(`${written} written`);
  };
  for (const o of source.orgs.values()) { await target.putOrg(o); tick(); }
  for (const a of source.accounts.values()) { await target.putAccount(a); tick(); }
  for (const [k, cid] of source.byIdentity) { await target.setIdentity(k, cid); tick(); }
  for (const [k, cid] of source.byFederation) { await target.setFederation(k, cid); tick(); }
  for (const k of source.authenticators.values()) { await target.putAuthenticator(k); tick(); }
  for (const x of source.sessions.values()) { await target.putSession(x); tick(); }
  for (const g of source.grants.values()) { await target.putGrant(g); tick(); }

  // Read everything back through the same interface CidService uses.
  const mismatches: string[] = [];
  const src = createHash("sha256");
  const dst = createHash("sha256");
  const compare = (label: string, want: unknown, got: unknown) => {
    const w = canonical(want);
    const g = got === undefined ? "undefined" : canonical(got);
    src.update(`${label}\n${w}\n`);
    dst.update(`${label}\n${g}\n`);
    if (w !== g) mismatches.push(label);
  };
  for (const o of source.orgs.values()) compare(`org ${o.id}`, o, await target.org(o.id));
  for (const a of source.accounts.values()) {
    compare(`account ${a.cid}`, a, await target.account(a.cid));
    compare(`username ${a.username}`, a.cid, await target.cidForUsername(a.username));
    compare(`sessions of ${a.cid}`, sessionsOf(source, a.cid), await target.sessionsOf(a.cid));
    compare(`keys of ${a.cid}`, keysOf(source, a.cid), await target.authenticatorsOf(a.cid));
    compare(`grants of ${a.cid}`, grantsOf(source, a.cid), await target.grantsOf(a.cid));
  }
  for (const [k, cid] of source.byIdentity) compare(`identity ${k}`, cid, await target.cidForIdentity(k));
  for (const [k, cid] of source.byFederation) compare(`federation ${k}`, cid, await target.cidForFederation(k));
  for (const k of source.authenticators.values()) compare(`credential ${k.credentialId}`, k, await target.authenticatorByCredential(k.credentialId));
  for (const x of source.sessions.values()) compare(`token ${x.id}`, x, await target.sessionByTokenHash(x.tokenHash));
  return { ...check, written, mismatches, sourceHash: src.digest("hex"), targetHash: dst.digest("hex") };
}

const sessionsOf = (s: CidStore, cid: string): Session[] => [...s.sessions.values()].filter((x) => x.cid === cid);
const keysOf = (s: CidStore, cid: string): Authenticator[] => [...s.authenticators.values()].filter((x) => x.cid === cid);
const grantsOf = (s: CidStore, cid: string): Grant[] => [...s.grants.values()].filter((x) => x.cid === cid);
