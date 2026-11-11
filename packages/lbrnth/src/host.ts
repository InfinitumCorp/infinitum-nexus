import { createHash, hkdfSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CidLabyrinth } from "./auth.ts";
import type { CidAuthority, DelegationGrant, DelegationStore } from "./auth.ts";
import { CidDirectoryError } from "./directory.ts";
import type { CidDirectory, DirectoryOrg } from "./directory.ts";
import { LABYRINTH_HTTP_LIMIT, labyrinthCommand, labyrinthErrorStatus, labyrinthToken } from "./http.ts";
import type { LabyrinthLimits } from "./limits.ts";
import { LabyrinthError } from "./model.ts";
import type { Scope } from "./model.ts";
import { LabyrinthStorageConflict, PostgresStorage } from "./postgres.ts";
import type { SqlDatabase, SqlQueryable } from "./postgres.ts";
import { Labyrinth } from "./service.ts";

export interface LabyrinthHostOptions {
  /** Postgres (Supabase) with supabase/migrations/20261111_lbrnth_store.sql applied. */
  db: SqlDatabase;
  /** 32-byte root secret. Per-organization keys are HKDF-derived exactly as in the file adapter. */
  masterKey: Uint8Array;
  /** The authoritative Cumulus://ID directory (RemoteCidDirectory in production). */
  directory: CidDirectory;
  /** Operator allowlist, in addition to active rows in lbrnth.entitlements. Read on every request. */
  entitledOrgs?: () => readonly string[];
  clock?: () => Date;
  limits?: Partial<LabyrinthLimits>;
}

export interface HostResponse { status: number; body: unknown }

interface View {
  token: string;
  actor: string;
  sessionId: string;
  direct: boolean;
  sessionActive: boolean;
  org: DirectoryOrg | null;
  scopes: Scope[];
  others: Map<string, DirectoryOrg | null>;
  entitled: boolean;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const denied = (status: number): HostResponse => ({ status, body: { error: status >= 500 ? "Labyrinth unavailable" : status === 401 ? "Invalid Cumulus ID session or client organization" : "Labyrinth request denied" } });

/** Delegation grants for one request, with the changes to write in the same transaction. */
class TrackedDelegations implements DelegationStore {
  readonly #map = new Map<string, DelegationGrant>();
  readonly #added = new Map<string, DelegationGrant>();
  readonly #removed = new Set<string>();
  constructor(rows: Iterable<[string, DelegationGrant]>) { for (const [k, v] of rows) this.#map.set(k, v); }
  get(hash: string) { return this.#map.get(hash); }
  set(hash: string, grant: DelegationGrant) { this.#map.set(hash, grant); this.#added.set(hash, grant); this.#removed.delete(hash); }
  delete(hash: string) { this.#map.delete(hash); this.#added.delete(hash); this.#removed.add(hash); }
  entries() { return this.#map.entries(); }
  get size() { return this.#map.size; }
  get changed() { return this.#added.size > 0 || this.#removed.size > 0; }
  async persist(tx: SqlQueryable, now: Date) {
    for (const hash of this.#removed) await tx.query("delete from lbrnth.delegations where token_hash = $1", [hash]);
    for (const [hash, g] of this.#added) {
      await tx.query("insert into lbrnth.delegations (token_hash, cid, org_id, parent_session, expires_at) values ($1, $2, $3, $4, $5) on conflict (token_hash) do nothing", [hash, g.cid, g.orgId, g.parentSession, new Date(g.expires)]);
    }
    await tx.query("delete from lbrnth.delegations where expires_at <= $1", [now]);
  }
}

/**
 * The authoritative hosted Labyrinth: Cumulus://ID sessions checked live against the CID
 * directory, the paid-plan check (lbrnth.entitlements plus an operator allowlist), first-org
 * onboarding, 15-minute repository-only bearers, and durable Postgres storage.
 *
 * Each request is one unit of work, serialized within the instance:
 *   refresh committed state -> resolve the caller live -> run the synchronous SDK -> commit
 *   the changed envelopes and bearer grants in ONE transaction.
 * A response is only sent after that commit. If another instance committed first, nothing is
 * written, the state is reloaded and the request re-runs (twice at most).
 */
export class LabyrinthHost {
  readonly #opts: LabyrinthHostOptions;
  readonly #storage: PostgresStorage;
  readonly #clock: () => Date;
  #lab: Labyrinth | undefined;
  #view: View | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: LabyrinthHostOptions) {
    const master = Buffer.from(options.masterKey);
    if (master.length !== 32) throw new Error("Labyrinth host requires a 32-byte master key");
    this.#opts = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#storage = new PostgresStorage(options.db, org => new Uint8Array(hkdfSync("sha256", master, "Infinitum/LBRNTH/v1", org, 32)));
  }

  #build(): Labyrinth {
    return new Labyrinth({
      storage: this.#storage,
      clock: this.#opts.clock,
      limits: this.#opts.limits,
      can: (cid, _product, scope) => { const v = this.#view; return !!v && cid === v.actor && v.scopes.includes(scope); },
      entitled: orgId => { const v = this.#view; return !!v && v.entitled && v.org?.id === orgId; },
      canProvision: (cid, orgId) => { const v = this.#view; return !!v && cid === v.actor && v.direct && v.org?.id === orgId && v.org.admin; },
    });
  }

  #authority(view: View): CidAuthority {
    const directory = this.#opts.directory;
    return {
      authenticate: token => view.direct && token === view.token ? { account: { cid: view.actor }, session: { id: view.sessionId } } : null,
      // The presenting session is checked live. Other bearers' sessions are checked when presented.
      isSessionActive: (cid, sessionId) => cid === view.actor && sessionId === view.sessionId ? view.sessionActive : true,
      organizationMembership: cid => cid === view.actor ? view.org : view.others.get(cid) ?? null,
      can: (cid, app, scope) => cid === view.actor && app === "LBRNTH" && view.scopes.includes(scope as Scope),
      permissions: cid => cid === view.actor && view.scopes.length ? [{ app: "LBRNTH", scopes: [...view.scopes] }] : [],
      createOrganization: async (name, adminCid) => {
        if (!view.direct || adminCid !== view.actor) throw new LabyrinthError("forbidden", "Direct Cumulus ID sign-in required");
        return directory.createOrganization(view.token, name);
      },
      grant: async (cid, app, scopes) => {
        if (!view.direct || cid !== view.actor || app !== "LBRNTH") throw new LabyrinthError("forbidden", "Direct Cumulus ID sign-in required for consent");
        return directory.consent(view.token, scopes as Scope[]);
      },
    };
  }

  async #entitled(orgId: string): Promise<boolean> {
    if ((this.#opts.entitledOrgs?.() ?? []).includes(orgId)) return true;
    const rows = (await this.#opts.db.query("select 1 as ok from lbrnth.entitlements where org_id = $1 and active", [orgId])).rows;
    return rows.length > 0;
  }

  async #resolve(token: string, command: unknown, delegations: TrackedDelegations, now: Date): Promise<View | null> {
    const directory = this.#opts.directory;
    let view: View | null = null;
    if (token.startsWith("lbrnth_")) {
      const grant = delegations.get(sha256(token));
      if (!grant || grant.expires <= now.getTime()) return null;
      const s = await directory.session(grant.cid, grant.parentSession);
      if (!s.active) return null;
      view = { token, actor: grant.cid, sessionId: grant.parentSession, direct: false, sessionActive: true, org: s.organization, scopes: s.scopes, others: new Map(), entitled: false };
    } else {
      const id = await directory.resolve(token);
      if (!id) return null;
      view = { token, actor: id.cid, sessionId: id.sessionId, direct: true, sessionActive: true, org: id.organization, scopes: id.scopes, others: new Map(), entitled: false };
    }
    const p = command && typeof command === "object" ? command as Record<string, unknown> : {};
    if (p.action === "set-member" && p.memberRole !== null && typeof p.member === "string" && p.member.length > 0 && p.member.length <= 200 && p.member !== view.actor) {
      view.others.set(p.member, await directory.membership(p.member));
    }
    if (view.org) view.entitled = await this.#entitled(view.org.id);
    return view;
  }

  /** Run one Labyrinth command for a Cumulus ID token or repository bearer. */
  run(token: string, command: unknown): Promise<HostResponse> {
    const next = this.#queue.then(() => this.#attempt(token, command, 2));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #attempt(token: string, command: unknown, retries: number): Promise<HostResponse> {
    const now = this.#clock();
    let view: View | null;
    let delegations: TrackedDelegations;
    try {
      if ((await this.#storage.refresh()) || !this.#lab) this.#lab = this.#build();
      const rows = (await this.#opts.db.query<{ token_hash: string; cid: string; org_id: string; parent_session: string; expires_at: Date | string }>(
        "select token_hash, cid, org_id, parent_session, expires_at from lbrnth.delegations where expires_at > $1 order by expires_at desc limit 1000", [now])).rows;
      delegations = new TrackedDelegations(rows.map(r => [r.token_hash, { cid: r.cid, orgId: r.org_id, parentSession: r.parent_session, expires: new Date(r.expires_at).getTime() }]));
      view = await this.#resolve(token, command, delegations, now);
    } catch (err) {
      this.#lab = undefined;
      if (err instanceof CidDirectoryError) return denied(err.status === 401 ? 401 : 502);
      console.error("Labyrinth host: load failed", err instanceof Error ? err.message : err);
      return denied(503);
    }
    if (!view) return denied(401);

    const auth = new CidLabyrinth(this.#authority(view), { storage: this.#storage, labyrinth: this.#lab, delegations, entitled: () => false, clock: this.#opts.clock });
    this.#view = view;
    let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      try { auth.session(token); } catch { return denied(401); }
      try { outcome = { ok: true, value: await labyrinthCommand(auth, token, command) }; }
      catch (error) { outcome = { ok: false, error }; }
    } finally {
      this.#view = undefined;
    }

    // Commit what the command recorded (audit entries included) before answering, even when
    // the command itself was refused afterwards, exactly as the file-backed host did.
    if (this.#storage.dirty || delegations.changed) {
      try {
        await this.#storage.flush(tx => delegations.persist(tx, now));
      } catch (err) {
        this.#storage.discard();
        this.#lab = undefined; // in-memory SDK state may hold the uncommitted change
        if (err instanceof LabyrinthStorageConflict) return retries > 0 ? this.#attempt(token, command, retries - 1) : denied(409);
        console.error("Labyrinth host: commit failed", err instanceof Error ? err.message : err);
        return denied(503);
      }
    }
    if (outcome.ok) return { status: 200, body: outcome.value ?? null };
    const error = outcome.error;
    if (error instanceof CidDirectoryError) return denied(error.status === 502 ? 502 : error.status);
    const status = labyrinthErrorStatus(error);
    if (status >= 500) console.error("Labyrinth host: command failed", error instanceof Error ? error.message : error);
    return denied(status);
  }
}

/**
 * Node HTTP handler for the hosted service's POST /api/labyrinth. Bearer only: this host
 * has no CID cookie. The JSON content type and x-labyrinth header are still required.
 */
export async function serveLabyrinthHost(req: IncomingMessage, res: ServerResponse, host: LabyrinthHost | undefined): Promise<void> {
  const respond = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  if (!host) return respond(503, { error: "Labyrinth is not configured" });
  if (req.method !== "POST") return respond(405, { error: "POST required" });
  if (req.headers["x-labyrinth"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) return respond(403, { error: "JSON and Labyrinth request header required" });
  const token = req.headers.authorization !== undefined ? labyrinthToken(req.headers.authorization) : undefined;
  if (!token) return respond(401, { error: "Cumulus ID sign-in required" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > LABYRINTH_HTTP_LIMIT) return respond(413, { error: "Labyrinth request too large" });
    chunks.push(Buffer.from(chunk));
  }
  let command: unknown;
  try { command = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return respond(400, { error: "Labyrinth request denied" }); }
  const out = await host.run(token, command);
  respond(out.status, out.body);
}
