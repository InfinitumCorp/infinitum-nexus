/**
 * Cumulus://ID rows behind a gateway (the nexus-store edge function), for hosts that can't open a
 * Postgres connection or hold a database password (relational storage plan, phase 4).
 *
 * Reads go to the gateway (`read`, several lookups per call) and are remembered for the rest of the
 * request. Writes stay in memory, on top of what was read, until the host commits: `pending()` hands
 * them over to be applied in the same database transaction as the ledger and documents
 * (public.nexus_commit_cid). Each write carries the value the request read; if another server changed
 * that row in the meantime the commit raises a conflict and the host re-runs the request, so two
 * servers can't both use the same single-use code or overwrite each other's change.
 *
 * Requests on one instance must not overlap (RemoteState serializes them); `begin()` starts a fresh
 * request.
 */
import type { Account, Authenticator, CidOneTime, Grant, Organization, Session } from "./service.ts";
import type { CidRepository, OneTimeKind } from "./repository.ts";

export type CidReadOp =
  | { op: "account"; cid: string }
  | { op: "cidForUsername"; username: string }
  | { op: "accountsInOrg"; orgId: string }
  | { op: "allAccounts" }
  | { op: "cidForIdentity"; key: string }
  | { op: "cidForFederation"; key: string }
  | { op: "authenticator"; id: string }
  | { op: "authenticatorByCredential"; credentialId: string }
  | { op: "authenticatorsOf"; cid: string }
  | { op: "session"; id: string }
  | { op: "sessionByTokenHash"; tokenHash: string }
  | { op: "sessionBundle"; tokenHash: string }
  | { op: "sessionsOf"; cid: string }
  | { op: "grant"; cid: string; app: string }
  | { op: "grantsOf"; cid: string }
  | { op: "org"; id: string }
  | { op: "oneTime"; kind: string; key: string };

type Kind = "account" | "identity" | "federation" | "authenticator" | "session" | "grant" | "org" | "oneTime";

/** One write for public.nexus_commit_cid. `expect` absent: not checked; null: must not exist. */
export interface CidWriteOp {
  kind: Kind | "sweep";
  id: string;
  data?: unknown;
  expect?: unknown;
  now?: number;
}

/** Runs read ops on the server; one result per op, in order. */
export type CidReader = (ops: CidReadOp[]) => Promise<unknown[]>;

interface Known {
  value: any;
  /** As read from the server this request; undefined when never read (a blind write). */
  base?: any;
  dirty: boolean;
}

const copy = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

export class RemoteCidRepository implements CidRepository {
  readonly #read: CidReader;
  #known = new Map<string, Known>();
  #writes: string[] = []; // keys in first-write order
  #sweeps: CidWriteOp[] = [];
  /** Accounts whose grants were all read this request: a grant not among them doesn't exist. */
  #grantsLoaded = new Set<string>();

  constructor(read: CidReader) {
    this.#read = read;
  }

  /* ---------------- request lifecycle ---------------- */

  /** Forget everything: a new request (or a re-run) starts from the server's current rows. */
  begin(): void {
    this.#known.clear();
    this.#writes = [];
    this.#sweeps = [];
    this.#grantsLoaded.clear();
  }

  /** The request's writes, in order, for the commit. */
  pending(): CidWriteOp[] {
    const ops: CidWriteOp[] = [];
    for (const k of this.#writes) {
      const e = this.#known.get(k)!;
      const sep = k.indexOf(":");
      const op: CidWriteOp = { kind: k.slice(0, sep) as Kind, id: k.slice(sep + 1), data: e.value ?? null };
      if (e.base !== undefined) op.expect = e.base ?? null;
      ops.push(op);
    }
    return [...ops, ...this.#sweeps];
  }

  /* ---------------- internals ---------------- */

  async #one(op: CidReadOp): Promise<any> {
    const [r] = await this.#read([op]);
    return r ?? null;
  }

  async #entity(kind: Kind, id: string, op: CidReadOp): Promise<any> {
    const k = `${kind}:${id}`;
    const hit = this.#known.get(k);
    if (hit) return copy(hit.value);
    const value = await this.#one(op);
    this.#known.set(k, { value, base: value, dirty: false });
    return copy(value);
  }

  /** Remember a value the server returned in a list or lookup (unless this request already has its own). */
  #saw(kind: Kind, id: string, value: unknown) {
    const k = `${kind}:${id}`;
    if (!this.#known.has(k)) this.#known.set(k, { value, base: value, dirty: false });
  }

  #write(kind: Kind, id: string, value: unknown) {
    const k = `${kind}:${id}`;
    const e = this.#known.get(k);
    if (e) {
      e.value = copy(value);
      if (!e.dirty) {
        e.dirty = true;
        this.#writes.push(k);
      }
    } else {
      this.#known.set(k, { value: copy(value), dirty: true });
      this.#writes.push(k);
    }
  }

  /** This request's own (changed) entities of a kind. */
  *#local(kind: Kind): Generator<[string, any]> {
    for (const k of this.#writes) {
      if (!k.startsWith(`${kind}:`)) continue;
      yield [k.slice(kind.length + 1), this.#known.get(k)!.value];
    }
  }

  /** A server list with this request's changes applied: changed items replaced or dropped, new ones appended. */
  #merge<T>(kind: Kind, server: T[], idOf: (v: T) => string, keep: (v: T) => boolean): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const item of server) {
      const id = idOf(item);
      seen.add(id);
      const e = this.#known.get(`${kind}:${id}`);
      if (e?.dirty) {
        if (e.value && keep(e.value)) out.push(copy(e.value));
      } else {
        this.#saw(kind, id, item);
        out.push(copy(e ? e.value : item));
      }
    }
    for (const [id, value] of this.#local(kind)) if (!seen.has(id) && value && keep(value)) out.push(copy(value));
    return out;
  }

  /** A unique lookup (username, credential id, token hash) with this request's changes applied. */
  async #lookup<T>(kind: Kind, op: CidReadOp, matches: (v: T) => boolean, idOf: (v: T) => string): Promise<T | undefined> {
    for (const [, value] of this.#local(kind)) if (value && matches(value)) return copy(value);
    const found = (await this.#one(op)) as T | null;
    if (!found) return undefined;
    const e = this.#known.get(`${kind}:${idOf(found)}`);
    if (e?.dirty) return e.value && matches(e.value) ? copy(e.value) : undefined;
    this.#saw(kind, idOf(found), found);
    return copy(e ? e.value : found);
  }

  /* ---------------- CidRepository ---------------- */

  async account(cid: string): Promise<Account | undefined> {
    return (await this.#entity("account", cid, { op: "account", cid })) ?? undefined;
  }
  async cidForUsername(username: string): Promise<string | undefined> {
    for (const [cid, a] of this.#local("account")) if (a?.username === username) return cid;
    const cid = (await this.#one({ op: "cidForUsername", username })) as string | null;
    if (!cid) return undefined;
    const e = this.#known.get(`account:${cid}`);
    if (e?.dirty && (!e.value || e.value.username !== username)) return undefined;
    return cid;
  }
  async putAccount(account: Account): Promise<void> {
    if (!this.#known.has(`account:${account.cid}`)) await this.account(account.cid); // read first, so the write is checked
    this.#write("account", account.cid, account);
  }
  async accountsInOrg(orgId: string): Promise<Account[]> {
    const server = (await this.#one({ op: "accountsInOrg", orgId })) as Account[];
    return this.#merge("account", server ?? [], (a) => a.cid, (a) => a.orgId === orgId);
  }
  async allAccounts(): Promise<Account[]> {
    const server = (await this.#one({ op: "allAccounts" })) as Account[];
    return this.#merge("account", server ?? [], (a) => a.cid, () => true);
  }

  async cidForIdentity(key: string): Promise<string | undefined> {
    return (await this.#entity("identity", key, { op: "cidForIdentity", key })) ?? undefined;
  }
  async setIdentity(key: string, cid: string): Promise<void> {
    this.#write("identity", key, cid);
  }
  async deleteIdentity(key: string): Promise<void> {
    this.#write("identity", key, null);
  }
  async cidForFederation(key: string): Promise<string | undefined> {
    return (await this.#entity("federation", key, { op: "cidForFederation", key })) ?? undefined;
  }
  async setFederation(key: string, cid: string): Promise<void> {
    this.#write("federation", key, cid);
  }

  async authenticator(id: string): Promise<Authenticator | undefined> {
    return (await this.#entity("authenticator", id, { op: "authenticator", id })) ?? undefined;
  }
  authenticatorByCredential(credentialId: string): Promise<Authenticator | undefined> {
    return this.#lookup<Authenticator>("authenticator", { op: "authenticatorByCredential", credentialId }, (a) => a.credentialId === credentialId, (a) => a.id);
  }
  async authenticatorsOf(cid: string): Promise<Authenticator[]> {
    const server = (await this.#one({ op: "authenticatorsOf", cid })) as Authenticator[];
    return this.#merge("authenticator", server ?? [], (a) => a.id, (a) => a.cid === cid);
  }
  async putAuthenticator(auth: Authenticator): Promise<void> {
    if (!this.#known.has(`authenticator:${auth.id}`)) await this.authenticator(auth.id);
    this.#write("authenticator", auth.id, auth);
  }
  async deleteAuthenticator(auth: Authenticator): Promise<void> {
    if (!this.#known.has(`authenticator:${auth.id}`)) await this.authenticator(auth.id);
    this.#write("authenticator", auth.id, null);
  }

  async session(id: string): Promise<Session | undefined> {
    return (await this.#entity("session", id, { op: "session", id })) ?? undefined;
  }
  /**
   * Every signed-in request starts here, so one round trip brings the session, its account and the
   * account's grants (sessionBundle); the checks that follow are answered from memory.
   */
  async sessionByTokenHash(tokenHash: string): Promise<Session | undefined> {
    for (const [, value] of this.#local("session")) if (value && value.tokenHash === tokenHash) return copy(value);
    const bundle = (await this.#one({ op: "sessionBundle", tokenHash })) as { session: Session; account: Account | null; grants: Grant[] } | null;
    if (!bundle?.session) return undefined;
    const { session, account, grants } = bundle;
    if (account) this.#saw("account", account.cid, account);
    for (const g of grants ?? []) this.#saw("grant", `${g.cid}|${g.app}`, g);
    this.#grantsLoaded.add(session.cid);
    const e = this.#known.get(`session:${session.id}`);
    if (e?.dirty) return e.value && e.value.tokenHash === tokenHash ? copy(e.value) : undefined;
    this.#saw("session", session.id, session);
    return copy(e ? e.value : session);
  }
  async sessionsOf(cid: string): Promise<Session[]> {
    const server = (await this.#one({ op: "sessionsOf", cid })) as Session[];
    return this.#merge("session", server ?? [], (s) => s.id, (s) => s.cid === cid);
  }
  async putSession(session: Session): Promise<void> {
    // New sessions have fresh random ids: no read needed. Updates (revocation) were read first by the service.
    this.#write("session", session.id, session);
  }

  async grant(cid: string, app: string): Promise<Grant | undefined> {
    const k = `grant:${cid}|${app}`;
    if (!this.#known.has(k) && this.#grantsLoaded.has(cid)) this.#known.set(k, { value: null, base: null, dirty: false });
    return (await this.#entity("grant", `${cid}|${app}`, { op: "grant", cid, app })) ?? undefined;
  }
  async grantsOf(cid: string): Promise<Grant[]> {
    const server = (await this.#one({ op: "grantsOf", cid })) as Grant[];
    return this.#merge("grant", server ?? [], (g) => `${g.cid}|${g.app}`, (g) => g.cid === cid);
  }
  async putGrant(grant: Grant): Promise<void> {
    if (!this.#known.has(`grant:${grant.cid}|${grant.app}`)) await this.grant(grant.cid, grant.app);
    this.#write("grant", `${grant.cid}|${grant.app}`, grant);
  }
  async deleteGrant(cid: string, app: string): Promise<void> {
    if (!this.#known.has(`grant:${cid}|${app}`)) await this.grant(cid, app);
    this.#write("grant", `${cid}|${app}`, null);
  }

  async org(id: string): Promise<Organization | undefined> {
    return (await this.#entity("org", id, { op: "org", id })) ?? undefined;
  }
  async putOrg(org: Organization): Promise<void> {
    if (!this.#known.has(`org:${org.id}`)) await this.org(org.id);
    this.#write("org", org.id, org);
  }

  async putOneTime<K extends OneTimeKind>(kind: K, key: string, value: CidOneTime[K]): Promise<void> {
    this.#write("oneTime", `${kind}|${key}`, value);
  }
  async peekOneTime<K extends OneTimeKind>(kind: K, key: string): Promise<CidOneTime[K] | undefined> {
    return (await this.#entity("oneTime", `${kind}|${key}`, { op: "oneTime", kind, key })) ?? undefined;
  }
  /** Read, then delete on commit with a check that it is still there: of two servers, one wins. */
  async takeOneTime<K extends OneTimeKind>(kind: K, key: string): Promise<CidOneTime[K] | undefined> {
    const value = await this.peekOneTime(kind, key);
    if (value !== undefined) this.#write("oneTime", `${kind}|${key}`, null);
    return value;
  }
  async deleteOneTime(kind: OneTimeKind, key: string): Promise<void> {
    this.#write("oneTime", `${kind}|${key}`, null);
  }
  async sweepOneTime(kind: OneTimeKind, now: number): Promise<void> {
    this.#sweeps.push({ kind: "sweep", id: kind, now: Math.floor(now) });
    for (const [id, value] of this.#local("oneTime")) {
      if (id.startsWith(`${kind}|`) && value && (value as { expiresAt: number }).expiresAt < now) this.#write("oneTime", id, null);
    }
  }
}
