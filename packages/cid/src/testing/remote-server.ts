/**
 * An in-memory stand-in for the nexus-store ID rows (public.cid_read / cumulus_id.apply), with the same
 * rules: reads answer the whitelisted lookups; writes are checked against the value the request read
 * and unique usernames, credential ids and token hashes are enforced. A failed check throws
 * RowConflict and applies nothing.
 *
 * CID_TEST_REMOTE_REPO=1 runs the CID suites on RemoteCidRepository over this server, committing after
 * every write (testRemoteRepository), so every read after a write goes back to the "server".
 */
import { CidStore } from "../service.ts";
import { MapCidRepository } from "../repository.ts";
import { RemoteCidRepository, type CidReadOp, type CidWriteOp } from "../remote-repository.ts";

export class RowConflict extends Error {
  constructor(why: string) {
    super(`nexus_conflict: ${why}`);
  }
}

const json = <T>(v: T): T => (v === undefined ? (null as T) : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a ?? null)) === JSON.stringify(sortKeys(b ?? null));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export class TestCidServer {
  readonly repo = new MapCidRepository(new CidStore());
  reads = 0;
  commits = 0;

  async read(ops: CidReadOp[]): Promise<unknown[]> {
    this.reads++;
    const r = this.repo;
    const out: unknown[] = [];
    for (const o of ops) {
      switch (o.op) {
        case "account": out.push(await r.account(o.cid)); break;
        case "cidForUsername": out.push(await r.cidForUsername(o.username)); break;
        case "accountsInOrg": out.push(await r.accountsInOrg(o.orgId)); break;
        case "allAccounts": out.push(await r.allAccounts()); break;
        case "cidForIdentity": out.push(await r.cidForIdentity(o.key)); break;
        case "cidForFederation": out.push(await r.cidForFederation(o.key)); break;
        case "authenticator": out.push(await r.authenticator(o.id)); break;
        case "authenticatorByCredential": out.push(await r.authenticatorByCredential(o.credentialId)); break;
        case "authenticatorsOf": out.push(await r.authenticatorsOf(o.cid)); break;
        case "session": out.push(await r.session(o.id)); break;
        case "sessionByTokenHash": out.push(await r.sessionByTokenHash(o.tokenHash)); break;
        case "sessionsOf": out.push(await r.sessionsOf(o.cid)); break;
        case "sessionBundle": {
          const session = await r.sessionByTokenHash(o.tokenHash);
          out.push(session ? { session, account: (await r.account(session.cid)) ?? null, grants: await r.grantsOf(session.cid) } : null);
          break;
        }
        case "grant": out.push(await r.grant(o.cid, o.app)); break;
        case "grantsOf": out.push(await r.grantsOf(o.cid)); break;
        case "org": out.push(await r.org(o.id)); break;
        case "oneTime": out.push(await r.peekOneTime(o.kind as never, o.key)); break;
        default: throw new Error(`unknown op ${(o as { op: string }).op}`);
      }
    }
    return json(out);
  }

  /** Apply writes all-or-nothing, as nexus_commit_cid does. */
  async apply(ops: CidWriteOp[]): Promise<void> {
    const before = json(Object.fromEntries(Object.entries(this.repo.store).map(([k, v]) => [k, v instanceof Map ? [...v.entries()] : v])));
    try {
      for (const o of ops) await this.#apply(o);
      this.commits++;
    } catch (err) {
      const s = this.repo.store as unknown as Record<string, Map<unknown, unknown>>;
      for (const [k, entries] of Object.entries(before)) if (s[k] instanceof Map) { s[k].clear(); for (const [mk, mv] of entries as [unknown, unknown][]) s[k].set(mk, mv); }
      throw err;
    }
  }

  async #apply(o: CidWriteOp) {
    const r = this.repo;
    const s = r.store;
    const check = async (current: unknown) => {
      if ("expect" in o && !same(current, o.expect)) throw new RowConflict(`${o.kind} ${o.id} changed`);
    };
    const data = json(o.data) as any;
    switch (o.kind) {
      case "account": {
        await check(await r.account(o.id));
        if (!data) {
          const a = s.accounts.get(o.id);
          if (a) { s.accounts.delete(o.id); s.byUsername.delete(a.username); }
          return;
        }
        const holder = s.byUsername.get(data.username);
        if (holder && holder !== data.cid) throw new RowConflict("username taken");
        return r.putAccount(data);
      }
      case "identity":
        await check(await r.cidForIdentity(o.id));
        return data ? r.setIdentity(o.id, data) : r.deleteIdentity(o.id);
      case "federation":
        await check(await r.cidForFederation(o.id));
        if (data) return r.setFederation(o.id, data);
        s.byFederation.delete(o.id);
        return;
      case "authenticator": {
        const cur = await r.authenticator(o.id);
        await check(cur);
        if (!data) { if (cur) await r.deleteAuthenticator(cur); return; }
        const holder = s.byCredentialId.get(data.credentialId);
        if (holder && holder !== data.id) throw new RowConflict("credential id taken");
        return r.putAuthenticator(data);
      }
      case "session": {
        const cur = await r.session(o.id);
        await check(cur);
        if (!data) { if (cur) { s.sessions.delete(o.id); s.byTokenHash.delete(cur.tokenHash); } return; }
        const holder = s.byTokenHash.get(data.tokenHash);
        if (holder && holder !== data.id) throw new RowConflict("token hash taken");
        return r.putSession(data);
      }
      case "grant": {
        const [cid, app] = [o.id.slice(0, o.id.indexOf("|")), o.id.slice(o.id.indexOf("|") + 1)];
        await check(await r.grant(cid, app));
        return data ? r.putGrant(data) : r.deleteGrant(cid, app);
      }
      case "org":
        await check(await r.org(o.id));
        if (data) return r.putOrg(data);
        s.orgs.delete(o.id);
        return;
      case "oneTime": {
        const [kind, key] = [o.id.slice(0, o.id.indexOf("|")), o.id.slice(o.id.indexOf("|") + 1)] as ["challenge", string];
        await check(await r.peekOneTime(kind, key));
        return data ? r.putOneTime(kind, key, data as never) : r.deleteOneTime(kind, key);
      }
      case "sweep":
        return r.sweepOneTime(o.id as never, o.now ?? 0);
    }
  }
}

const MUTATORS = /^(put|set|delete|take|sweep)/;

/** A RemoteCidRepository that commits to `server` after every write and starts afresh (tests only). */
export function autoCommitRemoteRepository(server = new TestCidServer()): RemoteCidRepository {
  const repo = new RemoteCidRepository((ops) => server.read(ops));
  return new Proxy(repo, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || !MUTATORS.test(prop)) return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        await server.apply(target.pending());
        target.begin();
        return result;
      };
    },
  });
}
