import { serveNodeLabyrinthUI } from "@infinitum/lbrnth";
import { AiError, sharedRouter, type AiRouter } from "@infinitum/ai";
import { searchFromEnv, type ChatMessage, type Search } from "@infinitum/ai/search";
import { serveNodeLabyrinth, serveNodeLabyrinthProxy } from "@infinitum/lbrnth";
/**
 * Cumulus://Mail HTTP app. Sign-in is Cumulus://ID; every request is scoped to the signed-in CID,
 * and access needs the "cumulus-mail" grant, so revoking it in the CID permissions dashboard
 * cuts Mail off immediately.
 *
 * Mail is unlisted: every response carries noindex headers and robots.txt disallows everything.
 * People reach it from inside other Infinitum products (account menu, notices), not from the site.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { scalvsCleanAgent, type CleanAgent, type CleanSuggestion } from "./clean-agent.ts";
import { bulkSenders, classify, inboxMix, THREAD_ACTIONS, type ThreadAction, type ThreadSnapshot } from "@infinitum/mail";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { CidError, MAIL_DOMAIN, UpstreamIdClient, UpstreamIdError, cumulusCorsHeaders, type Account } from "@infinitum/cid";
import { QuotaError } from "@infinitum/cloud";
import { WalletError } from "@infinitum/firm";
import { MailError, isE2E, threadOf, transcript, type MailMessage } from "@infinitum/mail";
import type { CumulusSuite } from "@infinitum/cumulus";
import { MAX_FILE_BYTES, isFileKey, safeType, uploadKey, type FileStore } from "./files.ts";
import { DriveError, MAX_UPLOAD_BYTES, Workspace, WorkspaceStore, type DocKind } from "./workspace.ts";
import { registerIdProvider } from "./id-provider.ts";
import { registerBilling } from "./billing.ts";
import { BillingLinkStore, RevenueClient } from "@infinitum/billing";

export const MAIL_SCOPES = ["mail:read", "mail:write"];
/** Drive and the office apps (Dox, Spreads, Podium) use the Cumulus://Cloud grant, so it can be revoked apart from Mail. */
export const DRIVE_APP = "cumulus-cloud";
export const DRIVE_SCOPES = ["drive:read", "drive:write"];
const COOKIE = "cmail_session";
const OAUTH_COOKIE = "cmail_oauth";
const UPSTREAM_COOKIE = "cmail_cid";
/** The legacy "Sign in with Cumulus://ID" alias. In upstream mode each one forwards to the issuer. */
const ID_ALIAS_ROUTES: [method: string, path: string][] = [
  ["GET", "/api/id/authorize"], ["GET", "/api/id/redeem"], ["GET", "/api/id/end"], ["GET", "/api/id/userinfo"], ["GET", "/api/id/me"],
  ["POST", "/api/id/token"], ["POST", "/api/id/signout"],
];
const MAX_BODY = 25_000_000;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface MailAppDeps {
  suite: CumulusSuite;
  /**
   * Hosted Labyrinth service used when this host has no local Labyrinth storage. Omit to read
   * LBRNTH_ENDPOINT; null turns the relay off. Only an explicit Cumulus ID bearer is forwarded.
   */
  labyrinthEndpoint?: string | null;
  publicDir: string;
  origin: string;
  secureCookies: boolean;
  /** Parent domain, for example .cumuluscloud.app. Omit on localhost. */
  cookieDomain?: string;
  onChange?: () => void;
  /** Open-model router for SCALVS; defaults to the shared router built from the environment. */
  ai?: AiRouter;
  /** Infinitum Search (cited web answers). Defaults to SEARXNG_URL / YANDEX_* / BRAVE_* from the environment; null turns it off. */
  search?: Search | null;
  /** Hosted mode: wraps each API request (sync, run, save). See src/vercel.ts. */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Serverless hosts can't keep a timer running; they call sendDue from a cron route instead. */
  noTimers?: boolean;
  /** SCALVS briefs; default to the open-model router. */
  /** SCALVS Clean suggestions; default to the SCALVS agent when a model host is configured, else the rules. */
  cleanAgent?: CleanAgent;
  scalvs?: (mode: "summary" | "draft", owner: string, subject: string, text: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  /** Attachment contents (R2 on Workers). Without it, attaching files is turned off. */
  files?: FileStore;
  /** Drive metadata, saved with the rest of the shared state. Defaults to an in-memory store. */
  workspaceStore?: WorkspaceStore;
  /** CID -> billing org links, saved with the rest of the shared state. Defaults to an in-memory store. */
  billingStore?: BillingLinkStore;
  /** Infinitum revenue API (Stripe Checkout, portal, entitlements). Defaults to the production API. */
  revenue?: RevenueClient;
  /** Upstream mode only: how Mail calls the Cumulus://ID token endpoint. Defaults to fetch (tests inject one). */
  upstreamFetch?: typeof fetch;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
class Redirect {
  readonly location: string;
  /** 302 by default; 307 keeps the method and body (used to forward POSTs to the issuer). */
  readonly status: 302 | 307;
  constructor(location: string, status: 302 | 307 = 302) {
    this.location = location;
    this.status = status;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: Record<string, any>;
  query: URLSearchParams;
  user?: { account: Account; sessionId: string };
}
type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

function parseCookies(header = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Record<string, any>> {
  if (req.method === "GET" || req.method === "HEAD") return {};
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Message too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

const str = (v: unknown, max = 100_000) => String(v ?? "").slice(0, max);
/** Your Cumulus://ID is your mail address: "alex@cumuluscloud.app" and "alex" name the same account. */
const MAIL_SUFFIX = `@${MAIL_DOMAIN}`;
const idName = (v: unknown) => {
  const value = str(v, 80).trim().toLowerCase();
  return (value.endsWith(MAIL_SUFFIX) ? value.slice(0, -MAIL_SUFFIX.length) : value).slice(0, 40);
};
/** Drive file references on a message: names and sizes only, at most 10, each under 25 MB. */
const files = (v: unknown) => (Array.isArray(v) ? v : []).slice(0, 10)
  .map((f) => ({
    name: str(f?.name, 200).trim(),
    size: Math.floor(Number(f?.size)),
    ...(typeof f?.id === "string" && isFileKey(f.id) ? { id: f.id as string, type: safeType(f?.type) } : {}),
  }))
  .filter((f) => f.name && Number.isFinite(f.size) && f.size >= 0 && f.size <= MAX_FILE_BYTES);

/** SCALVS briefs and drafts on open-weight models (OmniRoute first, automatic fallback). */
function routerScalvs(router: AiRouter) {
  return async (mode: "summary" | "draft", owner: string, subject: string, text: string) => {
    if (!router.connected) return { ok: false as const, error: "Set OMNIROUTE_API_KEY to turn on SCALVS." };
    const system =
      mode === "summary"
        ? "You are SCALVS inside Cumulus://Mail. Three short lines of what matters, then one line that starts with Action:. Plain text. No invented facts."
        : `You are SCALVS drafting a reply for ${owner}. Reply body only. No subject line. No invented commitments.`;
    try {
      const reply = (await router.complete(system, `Subject: ${subject.slice(0, 200)}\n\n${text.slice(0, 6000)}`, { maxTokens: 400, tier: "fast", temperature: 0.3 })).trim();
      if (!reply) return { ok: false as const, error: "SCALVS returned an empty brief." };
      return { ok: true as const, text: reply };
    } catch (err) {
      const status = err instanceof AiError ? err.status : undefined;
      return { ok: false as const, error: `SCALVS could not read this thread${status ? ` (${status})` : ""}.` };
    }
  };
}

/** Infinitum Search from the environment, answering with SCALVS on the open-model router. */
function mailSearchFromEnv(router: AiRouter): Search | null {
  const chat = async (messages: ChatMessage[]) => {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const user = messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
    return router.complete(system, user, { maxTokens: 1200, tier: "fast", temperature: 0.2 });
  };
  try {
    return searchFromEnv(process.env, router.connected ? { chat } : {});
  } catch (err) {
    console.warn(`Infinitum Search is off: ${(err as Error).message}`);
    return null;
  }
}

export function createMailApp(deps: MailAppDeps) {
  const { suite } = deps;
  const { cid, mail } = suite;
  const ai = deps.ai ?? sharedRouter();
  const scalvs = deps.scalvs ?? routerScalvs(ai);
  const cleanAgent = deps.cleanAgent ?? scalvsCleanAgent({ router: ai });
  const search = deps.search !== undefined ? deps.search : mailSearchFromEnv(ai);
  const searchTimes = new Map<string, number[]>();
  const suggestions = new Map<string, { list: CleanSuggestion[]; note: string }>(); // per CID, in memory until approved
  const routes: { method: string; pattern: RegExp; keys: string[]; auth: boolean; optionalAuth: boolean; csrf: boolean; drive: boolean; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true, opts: { csrf?: boolean; optionalAuth?: boolean; drive?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, pattern, keys, auth, handler, csrf: opts.csrf ?? true, optionalAuth: opts.optionalAuth ?? false, drive: opts.drive ?? false });
  };
  const briefs = new Map<string, string>(); // `${cid}|${messageIds}` -> brief, kept in memory only

  const domainAttr = deps.cookieDomain ? `; Domain=${deps.cookieDomain}` : "";
  const sessionCookie = (token: string, maxAge = 30 * 86400) =>
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${domainAttr}${deps.secureCookies ? "; Secure" : ""}`;
  const device = (ctx: Ctx) => String(ctx.req.headers["user-agent"] ?? "Browser").slice(0, 120);
  const need = (ctx: Ctx, ...fields: string[]) => {
    for (const f of fields) if (ctx.body[f] === undefined || ctx.body[f] === "") throw new HttpError(400, `Missing ${f}`);
  };
  /** Signing in to Mail grants Mail access to the mailbox; the grant is recorded on Firmament. */
  const ensureGrant = async (account: Account) => {
    let missing = false;
    for (const s of MAIL_SCOPES) if (!(await cid.can(account.cid, "cumulus-mail", s))) missing = true;
    if (missing) await cid.grant(account.cid, "cumulus-mail", MAIL_SCOPES);
    await suite.summary(account.cid); // provisions older CIDs on first visit
  };
  const me = (ctx: Ctx) => ctx.user!.account.cid;

  /* ---------------- Cumulus://Drive, Dox, Spreads and Podium ---------------- */

  const workspace = new Workspace({
    store: deps.workspaceStore ?? new WorkspaceStore(),
    quota: suite.quota,
    files: deps.files,
    resolve: (who) => cid.cidForUsername(idName(who)),
    label: async (c) => (await cid.findAccount(c))?.mailAddress ?? "a Cumulus user",
  });
  /** Drive turns on the first time someone opens it; after that the CID permissions dashboard decides. */
  const driveAccess = async (cidValue: string, write: boolean) => {
    if (workspace.firstVisit(cidValue)) await cid.grant(cidValue, DRIVE_APP, DRIVE_SCOPES);
    if (!await cid.can(cidValue, DRIVE_APP, write ? "drive:write" : "drive:read")) throw new HttpError(403, "Drive's access was revoked in your Cumulus://ID permissions");
  };
  const KIND_LABEL: Record<string, string> = { folder: "a folder", file: "a file", dox: "a document", spreads: "a spreadsheet", podium: "a presentation" };
  const itemLink = (kind: string, id: string) => `${deps.origin}/drive/#/${kind}/${id}`;
  const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "video/mp4", "video/webm", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav"]);

  /**
   * Drive uploads and downloads carry raw bytes, so they skip the JSON routes:
   *   POST /api/drive/upload?name=plan.pdf&parent={folder}   body = the file
   *   GET  /api/drive/items/{id}/download[?inline=1]
   */
  const driveRaw = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const write = req.method !== "GET" && req.method !== "HEAD";
    const signedIn = async () => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = token ? await cid.authenticate(token) : null;
      if (!session) throw new HttpError(401, "Please sign in");
      await driveAccess(session.account.cid, write);
      return session.account.cid;
    };
    const inTx = <T>(fn: () => Promise<T>) => (deps.transaction ? deps.transaction(fn) : fn());
    if (req.method === "POST" && url.pathname === "/api/drive/upload") {
      if (req.headers["x-cumulus"] !== "1") throw new HttpError(403, "Missing request header");
      if (Number(req.headers["content-length"]) > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files up to 50 MB can be uploaded here.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Files up to 50 MB can be uploaded here.");
        chunks.push(c as Buffer);
      }
      const data = new Uint8Array(Buffer.concat(chunks));
      const item = await inTx(async () => workspace.upload(await signedIn(), url.searchParams.get("name"), url.searchParams.get("parent"), data, safeType(req.headers["content-type"])));
      deps.onChange?.();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(item));
      return;
    }
    const m = /^\/api\/drive\/items\/([0-9a-f-]{36})\/download$/.exec(url.pathname);
    if ((req.method === "GET" || req.method === "HEAD") && m) {
      const { item, data, type } = await inTx(async () => workspace.download(await signedIn(), m[1]!));
      const inline = url.searchParams.get("inline") === "1" && INLINE_TYPES.has(type);
      const filename = item.kind === "file" ? item.name : `${item.name}.${item.kind}.json`;
      res.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(data.byteLength),
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Content-Type-Options": "nosniff",
        // Never runs as this origin, even when shown inline.
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
        "Cache-Control": "private, no-cache",
      });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }
    throw new HttpError(405, "Method not allowed");
  };

  const drive = { drive: true };
  route("GET", "/api/drive", async (ctx) => workspace.list(me(ctx), { folder: ctx.query.get("folder"), view: ctx.query.get("view") ?? undefined, q: ctx.query.get("q") ?? undefined }), true, drive);
  route("GET", "/api/drive/items/:id", async (ctx) => workspace.get(me(ctx), ctx.params.id), true, drive);
  route("POST", "/api/drive/folders", async (ctx) => workspace.createFolder(me(ctx), ctx.body.name, ctx.body.parent ?? null), true, drive);
  route("POST", "/api/drive/docs", async (ctx) => {
    need(ctx, "kind");
    return workspace.createDoc(me(ctx), str(ctx.body.kind, 10) as DocKind, ctx.body.name, ctx.body.parent ?? null, ctx.body.content);
  }, true, drive);
  route("PATCH", "/api/drive/items/:id", async (ctx) => workspace.update(me(ctx), ctx.params.id, { name: ctx.body.name, parent: ctx.body.parent, starred: ctx.body.starred, trashed: ctx.body.trashed }), true, drive);
  route("DELETE", "/api/drive/items/:id", async (ctx) => workspace.remove(me(ctx), ctx.params.id), true, drive);
  route("POST", "/api/drive/trash/empty", async (ctx) => workspace.emptyTrash(me(ctx)), true, drive);
  route("GET", "/api/drive/items/:id/doc", async (ctx) => workspace.readDoc(me(ctx), ctx.params.id), true, drive);
  route("PUT", "/api/drive/items/:id/doc", async (ctx) => {
    need(ctx, "doc", "version");
    return workspace.saveDoc(me(ctx), ctx.params.id, ctx.body.doc, Number(ctx.body.version));
  }, true, drive);
  route("POST", "/api/drive/items/:id/share", async (ctx) => {
    need(ctx, "with");
    const { item, target } = await workspace.share(me(ctx), ctx.params.id, idName(ctx.body.with));
    const from = ctx.user!.account;
    await mail.notify(target, "cloud", {
      subject: `${from.username} shared “${item.name}” with you`,
      body: [`${from.mailAddress} shared ${KIND_LABEL[item.kind] ?? "a file"} with you in Cumulus://Drive:`, "", item.name, itemLink(item.kind, item.id), "", "You can open and edit it. It also appears under Shared with me in Drive.", "", "Cumulus://Cloud"].join("\n"),
    });
    return item;
  }, true, drive);
  route("DELETE", "/api/drive/items/:id/share/:who", async (ctx) => workspace.unshare(me(ctx), ctx.params.id, idName(ctx.params.who)), true, drive);
  route("POST", "/api/drive/items/:id/leave", async (ctx) => workspace.leave(me(ctx), ctx.params.id), true, drive);

  /* ---------------- "Sign in with Cumulus://ID" for every Infinitum product ---------------- */

  if (cid.upstreamIssuer) {
    // Upstream mode: id.cumuluscloud.app is the only issuer. Buttons that still point at Mail are
    // forwarded there unchanged (307 keeps POST bodies), so every product gets the issuer's cid.
    for (const [method, path] of ID_ALIAS_ROUTES) {
      route(method, path, (ctx) => new Redirect(`${cid.upstreamIssuer}${path}${ctx.query.size ? `?${ctx.query}` : ""}`, 307), false, { csrf: false });
    }
  } else {
    registerIdProvider({ route, cid, origin: deps.origin, sessionCookie, device, need, str, Redirect, HttpError });
  }

  /* ---------------- Buying Infinitum products with a Cumulus://ID (see billing.ts) ---------------- */

  registerBilling({
    route, cid, origin: deps.origin, str, Redirect, HttpError,
    store: deps.billingStore ?? new BillingLinkStore(),
    // REVENUE_CID_PARTNER_KEY: one billing org per Cumulus ID, shared with product apps (server-side secret).
    revenue: deps.revenue ?? new RevenueClient({ cidPartnerKey: process.env.REVENUE_CID_PARTNER_KEY }),
  });

  /**
   * Attachments carry raw bytes, so they skip the JSON routes:
   *   POST /api/files?name=plan.pdf   body = the file   -> { id, name, size, type }
   *   GET  /api/files/{id}                              -> the file, if it's on mail you can see
   */
  const fileRequest = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const store = deps.files;
    if (!store) throw new HttpError(503, "Attachments aren't available yet.");
    // Hosted: sessions live in the shared state, so check them inside a transaction (which loads it).
    const signedIn = async () => {
      const token = parseCookies(req.headers.cookie)[COOKIE];
      const session = token ? await cid.authenticate(token) : null;
      if (!session) throw new HttpError(401, "Please sign in");
      const scope = req.method === "GET" ? "mail:read" : "mail:write";
      if (!await cid.can(session.account.cid, "cumulus-mail", scope)) throw new HttpError(403, "Mail's access was revoked in your Cumulus://ID permissions");
      return session.account.cid;
    };
    const owner = deps.transaction ? await deps.transaction(signedIn) : await signedIn();

    if (req.method === "POST" && url.pathname === "/api/files") {
      if (req.headers["x-cumulus"] !== "1") throw new HttpError(403, "Missing request header");
      const name = str(url.searchParams.get("name"), 200).replace(/[\u0000-\u001f\u007f]/g, "").trim() || "file";
      const declared = Number(req.headers["content-length"]);
      if (declared > MAX_FILE_BYTES) throw new HttpError(413, "Files stay under 25 MB. Larger ones belong in Cloud.");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_FILE_BYTES) throw new HttpError(413, "Files stay under 25 MB. Larger ones belong in Cloud.");
        chunks.push(c as Buffer);
      }
      const type = safeType(req.headers["content-type"]);
      const id = uploadKey(owner);
      await store.put(id, new Uint8Array(Buffer.concat(chunks)), type);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ id, name, size, type }));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
      const key = decodeURIComponent(url.pathname.slice("/api/files/".length));
      if (!isFileKey(key)) throw new HttpError(404, "Not found");
      const check = async () => {
        const found = (await mail.view(owner)).messages.flatMap((m) => m.attachments ?? []).find((a) => a.id === key);
        return key.startsWith(`u/${owner}/`) || found ? (found ?? { name: "file" }) : null;
      };
      const meta = deps.transaction ? await deps.transaction(check) : await check();
      if (!meta) throw new HttpError(404, "Not found");
      const file = await store.get(key);
      if (!file) throw new HttpError(404, "That file is no longer available.");
      const filename = (meta.name || "file").replace(/["\\\r\n]/g, "_");
      res.writeHead(200, {
        "Content-Type": file.type,
        "Content-Length": String(file.data.byteLength),
        // Always a download, never rendered on this origin.
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, max-age=3600",
      });
      res.end(file.data);
      return;
    }
    throw new HttpError(405, "Method not allowed");
  };
  /** Stored files this person may use: their own uploads, or files on mail in their mailbox (forwarding). */
  const canUseFile = async (cidValue: string, key: string) =>
    key.startsWith(`u/${cidValue}/`) || (await mail.view(cidValue)).messages.some((m) => (m.attachments ?? []).some((a) => a.id === key));
  const ownFiles = async (cidValue: string, v: unknown) => {
    const list = files(v);
    for (const f of list) if (f.id && !(await canUseFile(cidValue, f.id))) throw new HttpError(403, "One of the attached files isn't yours to send.");
    return list;
  };

  const state = async (cidValue: string) => {
    await mail.autoClean(cidValue); // the Clean rules run on their own, at most once an hour
    const view = { ...(await mail.view(cidValue)), quota: await mail.quotaOf(cidValue) };
    const prefix = `${cidValue}|`;
    const own = Object.fromEntries([...briefs].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
    return { ...view, messages: view.messages.map((m) => ({ ...m, kind: classify(m) })), briefs: own, account: await suite.summary(cidValue), tunnel: { fingerprint: mail.fingerprint(cidValue), atRest: suite.tunnel.persistent } };
  };

  /* ---------------- Cumulus://ID sign-in ---------------- */

  route("POST", "/api/auth/signup", async (ctx) => {
    need(ctx, "username");
    const account = await cid.createAccount({ username: idName(ctx.body.username) });
    return { cid: account.cid, options: await cid.startAuthenticatorRegistration(account.cid, "passkey") };
  }, false);

  route("POST", "/api/auth/signup/finish", async (ctx) => {
    need(ctx, "cid", "response");
    await cid.finishAuthenticatorRegistration(str(ctx.body.cid), ctx.body.response, { kind: "passkey", label: str(ctx.body.label ?? "Passkey", 60) });
    const account = await cid.getAccount(str(ctx.body.cid));
    return { signedUp: true, options: await cid.startSignIn(account.username) };
  }, false);

  route("POST", "/api/auth/signin", async (ctx) => ({ options: await cid.startSignIn(ctx.body.username ? idName(ctx.body.username) : undefined) }), false);

  route("POST", "/api/auth/signin/finish", async (ctx) => {
    need(ctx, "response");
    const result = await cid.finishSignIn(ctx.body.response, device(ctx));
    if (result.status === "mfa_required") return result;
    ctx.res.setHeader("Set-Cookie", sessionCookie(result.token));
    await ensureGrant(await cid.getAccount(result.session.cid));
    return { status: "ok" };
  }, false);

  route("POST", "/api/auth/mfa", async (ctx) => {
    need(ctx, "mfaToken", "code");
    const { token, session } = await cid.completeMfa(str(ctx.body.mfaToken), str(ctx.body.code, 10));
    ctx.res.setHeader("Set-Cookie", sessionCookie(token));
    await ensureGrant(await cid.getAccount(session.cid));
    return { status: "ok" };
  }, false);

  route("POST", "/api/auth/signout", async (ctx) => {
    await cid.revokeSession(me(ctx), ctx.user!.sessionId);
    ctx.res.setHeader("Set-Cookie", sessionCookie("", 0));
    return { ok: true };
  });

  /*
   * Signing in the desktop app through the browser. Desktop shells can't always use the
   * computer's passkeys, so the app opens /?desktop=<challenge> in the browser; once you approve
   * there, the browser hands the app a one-time code (cumulus-mail://signin), and the app redeems
   * it with its secret verifier for its own session.
   */
  route("POST", "/api/auth/desktop/grant", async (ctx) => {
    need(ctx, "challenge");
    return cid.grantDeviceHandoff(me(ctx), str(ctx.body.challenge, 64), "cumulus-mail-desktop");
  });
  route("POST", "/api/auth/desktop/redeem", async (ctx) => {
    need(ctx, "code", "verifier");
    const { token, session } = await cid.redeemDeviceHandoff(str(ctx.body.code, 64), str(ctx.body.verifier, 128), device(ctx));
    ctx.res.setHeader("Set-Cookie", sessionCookie(token));
    await ensureGrant(await cid.getAccount(session.cid));
    return { status: "ok" };
  }, false);

  route("GET", "/api/auth/providers", () => cid.socialProvidersEnabled(), false);

  /* ---------------- Upstream mode: sign in at id.cumuluscloud.app ---------------- */

  /** Where the sign-in page should send people, or null when Mail still issues its own IDs. */
  route("GET", "/api/auth/issuer", () => ({ issuer: cid.upstreamIssuer ?? null }), false);
  if (cid.upstreamIssuer) {
    const upstream = new UpstreamIdClient({
      issuer: cid.upstreamIssuer,
      clientId: "cumulus-mail",
      redirectUri: `${deps.origin}/api/auth/cid/callback`,
      mailDomain: cid.mailDomain,
      fetchImpl: deps.upstreamFetch,
    });
    const upstreamCookie = (value: string, maxAge: number) =>
      `${UPSTREAM_COOKIE}=${value}; HttpOnly; Path=/api/auth/cid; SameSite=Lax; Max-Age=${maxAge}${deps.secureCookies ? "; Secure" : ""}`;
    route("GET", "/api/auth/cid/start", async (ctx) => {
      const { url, cookie } = upstream.start({ create: ctx.query.get("create") === "1" });
      ctx.res.setHeader("Set-Cookie", upstreamCookie(cookie, 600));
      return new Redirect(url);
    }, false);
    route("GET", "/api/auth/cid/callback", async (ctx) => {
      const q = ctx.query;
      const clear = upstreamCookie("", 0);
      if (q.get("error")) {
        ctx.res.setHeader("Set-Cookie", clear);
        return new Redirect(`/#/signin-error/${encodeURIComponent("Sign-in was cancelled.")}`);
      }
      try {
        const profile = await upstream.finish({ code: q.get("code"), state: q.get("state"), cookie: parseCookies(ctx.req.headers.cookie)[UPSTREAM_COOKIE] });
        const { token, session } = await cid.adoptUpstreamAccount(profile, device(ctx));
        ctx.res.setHeader("Set-Cookie", [clear, sessionCookie(token)]);
        await ensureGrant(await cid.getAccount(session.cid));
        return new Redirect("/");
      } catch (err) {
        ctx.res.setHeader("Set-Cookie", clear);
        const message = err instanceof CidError || err instanceof UpstreamIdError ? err.message : "Sign-in failed. Please try again.";
        return new Redirect(`/#/signin-error/${encodeURIComponent(message)}`);
      }
    }, false);
  }

  const oauthCookie = (provider: string, value: string, maxAge: number) => {
    const sameSite = provider === "apple" && deps.secureCookies ? "None" : "Lax";
    return `${OAUTH_COOKIE}=${value}; HttpOnly; Path=/api/auth/oauth; SameSite=${sameSite}; Max-Age=${maxAge}${domainAttr}${deps.secureCookies ? "; Secure" : ""}`;
  };
  route("GET", "/api/auth/oauth/:provider/start", async (ctx) => {
    const { url, state: st } = await cid.startSocialSignIn(ctx.params.provider, `${deps.origin}/api/auth/oauth/${ctx.params.provider}/callback`);
    ctx.res.setHeader("Set-Cookie", oauthCookie(ctx.params.provider, st, 600));
    return new Redirect(url);
  }, false);
  const oauthCallback: Handler = async (ctx) => {
    const p = ctx.req.method === "POST" ? ctx.body : Object.fromEntries(ctx.query);
    if (p.error) return new Redirect(`/#/signin-error/${encodeURIComponent("Sign-in was cancelled.")}`);
    try {
      const result = await cid.finishSocialSignIn(ctx.params.provider, { state: str(p.state), code: str(p.code), browserState: parseCookies(ctx.req.headers.cookie)[OAUTH_COOKIE] }, device(ctx));
      if (result.status === "mfa_required") return new Redirect(`/#/mfa/${result.mfaToken}`);
      if (result.status === "linked") return new Redirect("/");
      ctx.res.setHeader("Set-Cookie", [oauthCookie(ctx.params.provider, "", 0), sessionCookie(result.token)]);
      await ensureGrant(await cid.getAccount(result.session.cid));
      return new Redirect("/");
    } catch (err) {
      const message = err instanceof CidError ? err.message : "Sign-in failed. Please try again.";
      return new Redirect(`/#/signin-error/${encodeURIComponent(message)}`);
    }
  };
  route("GET", "/api/auth/oauth/:provider/callback", oauthCallback, false, { csrf: false });
  route("POST", "/api/auth/oauth/:provider/callback", oauthCallback, false, { csrf: false });

  /* ---------------- Account: one summary for every product ---------------- */

  route("GET", "/api/me", async (ctx) => suite.summary(me(ctx)));

  /* ---------------- Mail ---------------- */

  route("GET", "/api/state", async (ctx) => await state(me(ctx)));

  route("POST", "/api/send", async (ctx) => {
    const b = ctx.body;
    const payment = b.payment && str(b.payment.amount) ? { asset: str(b.payment.asset, 10), amount: str(b.payment.amount, 30) } : undefined;
    const result = await mail.send(me(ctx), {
      to: str(b.to, 4000), cc: str(b.cc ?? "", 4000), subject: str(b.subject, 300), body: str(b.body),
      threadId: b.threadId ? str(b.threadId, 80) : undefined, draftId: b.draftId ? str(b.draftId, 80) : undefined, payment,
      attachments: await ownFiles(me(ctx), b.attachments),
    });
    return { ...result, ok: true, state: await state(me(ctx)) };
  });

  route("POST", "/api/schedule", async (ctx) => {
    const b = ctx.body;
    const payment = b.payment && str(b.payment.amount) ? { asset: str(b.payment.asset, 10), amount: str(b.payment.amount, 30) } : undefined;
    const result = await mail.schedule(me(ctx), {
      to: str(b.to, 4000), cc: str(b.cc ?? "", 4000), subject: str(b.subject, 300), body: str(b.body),
      threadId: b.threadId ? str(b.threadId, 80) : undefined, draftId: b.draftId ? str(b.draftId, 80) : undefined, payment,
      attachments: await ownFiles(me(ctx), b.attachments),
    }, str(b.sendAt, 40));
    return { ...result, state: await state(me(ctx)) };
  });
  route("POST", "/api/schedule/cancel", async (ctx) => {
    if (!await mail.unschedule(me(ctx), str(ctx.body.id, 80))) throw new HttpError(404, "That message isn't scheduled.");
    return await state(me(ctx));
  });

  route("POST", "/api/draft", async (ctx) => {
    const b = ctx.body;
    const saved = await mail.saveDraft(me(ctx), { to: str(b.to, 4000), cc: str(b.cc ?? "", 4000), subject: str(b.subject, 300), body: str(b.body), threadId: b.threadId ? str(b.threadId, 80) : undefined, draftId: b.draftId ? str(b.draftId, 80) : undefined, attachments: await ownFiles(me(ctx), b.attachments) });
    return { ...saved, state: await state(me(ctx)) };
  });

  route("POST", "/api/read", async (ctx) => { if (ctx.body.threadId) await mail.markThreadRead(me(ctx), str(ctx.body.threadId, 80)); return await state(me(ctx)); });
  route("POST", "/api/star", async (ctx) => { if (ctx.body.id) await mail.toggleStar(me(ctx), str(ctx.body.id, 80)); return await state(me(ctx)); });
  route("POST", "/api/move", async (ctx) => { need(ctx, "id", "folder"); await mail.move(me(ctx), str(ctx.body.id, 80), str(ctx.body.folder, 20) as never); return await state(me(ctx)); });
  route("POST", "/api/snooze", async (ctx) => {
    need(ctx, "id", "until");
    if (!await mail.snooze(me(ctx), str(ctx.body.id, 80), str(ctx.body.until, 40))) throw new HttpError(404, "That message is not in this mailbox.");
    return await state(me(ctx));
  });
  route("POST", "/api/remove", async (ctx) => { if (ctx.body.id) await mail.remove(me(ctx), str(ctx.body.id, 80)); return await state(me(ctx)); });
  // Conversation actions. Each returns an undo id, kept in memory for 10 minutes.
  const undos = new Map<string, { cid: string; before: ThreadSnapshot[]; at: number }>();
  route("POST", "/api/threads", async (ctx) => {
    const action = str(ctx.body.action, 20) as ThreadAction;
    if (!THREAD_ACTIONS.includes(action)) throw new HttpError(400, "Unknown action");
    const ids = (Array.isArray(ctx.body.threadIds) ? ctx.body.threadIds : []).map((x: unknown) => str(x, 80)).filter(Boolean);
    if (!ids.length) throw new HttpError(400, "Pick at least one conversation");
    const { count, before } = await mail.actOnThreads(me(ctx), ids, action, str(ctx.body.box ?? "inbox", 20));
    const now = Date.now();
    for (const [k, v] of undos) if (now - v.at > 600_000) undos.delete(k);
    let undo: string | null = null;
    if (before.length) {
      undo = `u-${randomUUID()}`;
      undos.set(undo, { cid: me(ctx), before, at: now });
    }
    return { count, undo, state: await state(me(ctx)) };
  });
  route("POST", "/api/undo", async (ctx) => {
    const entry = undos.get(str(ctx.body.id, 80));
    if (!entry || entry.cid !== me(ctx)) throw new HttpError(404, "Nothing to undo.");
    undos.delete(str(ctx.body.id, 80));
    return { restored: await mail.restore(me(ctx), entry.before), state: await state(me(ctx)) };
  });
  route("POST", "/api/trash/empty", async (ctx) => ({ removed: await mail.emptyTrash(me(ctx)), state: await state(me(ctx)) }));
  route("POST", "/api/alias", async (ctx) => ({ ok: await mail.addAlias(me(ctx), str(ctx.body.alias, 120)), state: await state(me(ctx)) }));
  route("POST", "/api/task", async (ctx) => ({
    ok: await mail.addTask(me(ctx), { title: str(ctx.body.title ?? "Task", 180), detail: str(ctx.body.detail ?? "Queued from mail", 240), messageId: ctx.body.messageId ? str(ctx.body.messageId, 80) : undefined }),
    state: await state(me(ctx)),
  }));
  route("POST", "/api/task/toggle", async (ctx) => { if (ctx.body.id) await mail.toggleTask(me(ctx), str(ctx.body.id, 80)); return await state(me(ctx)); });
  route("POST", "/api/contact", async (ctx) => ({ ok: await mail.addContact(me(ctx), { name: str(ctx.body.name, 120), email: str(ctx.body.email, 200) }), state: await state(me(ctx)) }));

  route("GET", "/api/message", async (ctx) => {
    const message = await mail.message(me(ctx), ctx.query.get("id") ?? "");
    if (!message) throw new HttpError(404, "Not found");
    return { message, e2e: isE2E(message) };
  });

  route("POST", "/api/brief", async (ctx) => {
    const mode = ctx.body.mode === "draft" ? "draft" : "summary";
    const messages: MailMessage[] = (await mail.view(me(ctx))).messages;
    const thread = threadOf(messages, str(ctx.body.threadId, 80));
    if (!thread.length) throw new HttpError(404, "No such thread");
    const result = await scalvs(mode, ctx.user!.account.username, str(ctx.body.subject ?? thread[0]!.subject, 300), transcript(thread));
    if (!result.ok) throw new HttpError(400, result.error);
    if (mode === "summary") briefs.set(`${me(ctx)}|${thread.map((m) => m.id).join(":")}`, result.text);
    return result;
  });

  /* ---------------- Infinitum Search ---------------- */

  /** Is web search on, and which engines answer. */
  route("GET", "/api/web-search", () => ({ connected: Boolean(search), engines: search?.engines ?? [], answers: Boolean(search?.answers) }));
  /** A Perplexity-style answer: the engine finds pages, SCALVS reads them and answers with [n] citations. */
  route("POST", "/api/web-search", async (ctx) => {
    if (!search) throw new HttpError(503, "Web search isn't connected. Set SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID, or BRAVE_SEARCH_API_KEY.");
    const query = str(ctx.body.query, 1000).trim();
    if (!query) throw new HttpError(400, "Type something to search for");
    const now = Date.now();
    const times = (searchTimes.get(me(ctx)) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= 12) throw new HttpError(429, "Too many searches. Try again in a minute.");
    times.push(now);
    searchTimes.set(me(ctx), times);
    const r = await search.ask(query);
    return { query: r.query, answer: r.answer, cited: r.cited, sources: r.sources, engine: r.engine, read: r.read };
  });

  /* ---------------- SCALVS Clean ---------------- */

  const cleanView = async (cidValue: string) => {
    const c = await mail.cleanState(cidValue);
    const messages = (await mail.view(cidValue)).messages;
    const s = suggestions.get(cidValue);
    return {
      rules: c.rules,
      lastRun: c.lastRun ?? null,
      log: c.log.slice(0, 20).map(({ ids, ...e }) => ({ ...e, count: ids.length })),
      preview: (await mail.previewClean(cidValue)).map((a) => ({ kind: a.kind, count: a.ids.length, reason: a.reason })),
      mix: inboxMix(messages),
      senders: bulkSenders(messages, c.rules),
      suggestions: (s?.list ?? []).map(({ ids, ...x }) => ({ ...x, count: ids.length })),
      note: s?.note ?? "",
    };
  };
  const withState = async (cidValue: string, extra: object = {}) => {
    const st = await state(cidValue);
    return { ...extra, state: st, clean: await cleanView(cidValue) };
  };

  route("GET", "/api/clean", async (ctx) => cleanView(me(ctx)));
  route("POST", "/api/clean/rules", async (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ["auto", "newslettersAfterDays", "notificationsAfterDays", "bouncesAfterDays", "emptyTrashAfterDays"]) if (k in b) patch[k] = b[k];
    await mail.setCleanRules(me(ctx), patch);
    return withState(me(ctx));
  });
  route("POST", "/api/clean/run", async (ctx) => {
    const done = await mail.runClean(me(ctx), "you");
    return withState(me(ctx), { moved: done.reduce((n, e) => n + e.ids.length, 0) });
  });
  route("POST", "/api/clean/scalvs", async (ctx) => {
    const cidValue = me(ctx);
    const c = await mail.cleanState(cidValue);
    try {
      const result = await cleanAgent({ messages: (await mail.view(cidValue)).messages, rules: c.rules, preview: await mail.previewClean(cidValue), now: new Date() });
      suggestions.set(cidValue, { list: result.suggestions.slice(0, 12), note: result.note });
    } catch (err) {
      throw new HttpError(502, `SCALVS couldn't review your inbox right now (${(err as Error).message.slice(0, 80)}).`);
    }
    return withState(cidValue);
  });
  route("POST", "/api/clean/approve", async (ctx) => {
    const cidValue = me(ctx);
    const s = suggestions.get(cidValue);
    const pick = s?.list.find((x) => x.id === str(ctx.body.id, 80));
    if (!s || !pick) throw new HttpError(404, "That suggestion is gone. Ask SCALVS again.");
    if (pick.kind === "mute" && pick.email) await mail.muteSender(cidValue, pick.email);
    else if (pick.kind !== "mute") await mail.applyClean(cidValue, [{ kind: pick.kind, ids: pick.ids, reason: pick.reason }], pick.source === "scalvs" ? "scalvs" : "you");
    s.list = s.list.filter((x) => x.id !== pick.id);
    return withState(cidValue);
  });
  route("POST", "/api/clean/dismiss", async (ctx) => {
    const s = suggestions.get(me(ctx));
    if (s) s.list = s.list.filter((x) => x.id !== str(ctx.body.id, 80));
    return withState(me(ctx));
  });
  route("POST", "/api/clean/undo", async (ctx) => {
    const restored = await mail.undoClean(me(ctx), str(ctx.body.id, 80));
    return withState(me(ctx), { restored });
  });
  route("POST", "/api/clean/mute", async (ctx) => {
    need(ctx, "email");
    await mail.muteSender(me(ctx), str(ctx.body.email, 200));
    return withState(me(ctx));
  });
  route("POST", "/api/clean/unmute", async (ctx) => {
    need(ctx, "email");
    await mail.unmuteSender(me(ctx), str(ctx.body.email, 200));
    return withState(me(ctx));
  });

  /* ---------------- FIRM Wallet, inside Mail ---------------- */

  route("GET", "/api/wallet", async (ctx) => {
    const w = (await suite.wallets.get(me(ctx)))!;
    return { address: w.address, balances: await suite.wallets.balances(me(ctx)), history: await Promise.all((await suite.wallets.history(me(ctx))).map(async (t) => ({ ...t, direction: t.to === me(ctx) ? "in" : "out", counterparty: t.from === null ? "Settlement" : await mail.addressOf(t.to === me(ctx) ? t.from : t.to) }))) };
  });
  route("POST", "/api/wallet/pay", async (ctx) => {
    need(ctx, "to", "asset", "amount");
    const tx = await suite.pay(me(ctx), str(ctx.body.to, 200), str(ctx.body.asset, 10), str(ctx.body.amount, 30), str(ctx.body.memo ?? "", 140));
    return { tx, state: await state(me(ctx)) };
  });

  /* ---------------- HTTP plumbing ---------------- */

  async function serveStatic(path: string, res: ServerResponse) {
    const rel = normalize(path === "/" ? "index.html" : path.replace(/^\/+/, "") + (path.endsWith("/") ? "index.html" : ""));
    if (rel.startsWith("..") || rel.includes("\0")) throw new HttpError(404, "Not found");
    const full = join(deps.publicDir, rel);
    const root = deps.publicDir.endsWith(sep) ? deps.publicDir : deps.publicDir + sep;
    if (!full.startsWith(root)) throw new HttpError(404, "Not found");
    let data: Buffer;
    try {
      data = await readFile(full);
    } catch {
      throw new HttpError(404, "Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[extname(full)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Unlisted: never indexed, never framed.
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const cors = cumulusCorsHeaders(requestOrigin);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === "OPTIONS" && cors["Access-Control-Allow-Origin"]) {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/labyrinth" || url.pathname.startsWith("/labyrinth/")) return await serveNodeLabyrinthUI(req, res, "cumulus-mail");
      if (url.pathname === "/api/labyrinth") {
        const endpoint = (deps.labyrinthEndpoint === undefined ? process.env.LBRNTH_ENDPOINT : deps.labyrinthEndpoint) || undefined;
        if (!deps.suite?.labyrinth && endpoint) return await serveNodeLabyrinthProxy(req, res, endpoint, "cumulus-mail");
        return await serveNodeLabyrinth(req, res, deps.suite?.labyrinth, parseCookies(req.headers.cookie)[COOKIE], deps.onChange);
      }
      if (url.pathname === "/cumulus-config.js") {
        const body = `globalThis.CUMULUS=${JSON.stringify({ mailDomain: MAIL_DOMAIN })};`;
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
        res.end(body);
        return;
      }
      if (url.pathname === "/robots.txt") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("User-agent: *\nDisallow: /\n");
        return;
      }
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        return await serveStatic(url.pathname, res);
      }
      if (url.pathname === "/api/files" || url.pathname.startsWith("/api/files/")) return await fileRequest(req, res, url);
      if (url.pathname === "/api/drive/upload" || /^\/api\/drive\/items\/[^/]+\/download$/.test(url.pathname)) return await driveRaw(req, res, url);
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) throw new HttpError(404, "Not found");
      // CSRF: state-changing calls must come from Mail's own script.
      if (r.csrf && MUTATING.has(req.method!) && req.headers["x-cumulus"] !== "1") throw new HttpError(403, "Missing request header");
      const m = url.pathname.match(r.pattern)!;
      const ctx: Ctx = { req, res, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])), body: await readBody(req), query: url.searchParams };
      const run = async () => {
      if (r.auth || r.optionalAuth) {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        const session = token ? await cid.authenticate(token) : null;
        if (!session && r.auth) throw new HttpError(401, "Please sign in");
        if (session && r.drive) {
          await driveAccess(session.account.cid, MUTATING.has(req.method!));
          ctx.user = { account: session.account, sessionId: session.session.id };
        } else if (session) {
          const scope = MUTATING.has(req.method!) ? "mail:write" : "mail:read";
          if (r.auth && !await cid.can(session.account.cid, "cumulus-mail", scope)) throw new HttpError(403, "Mail's access was revoked in your Cumulus://ID permissions");
          ctx.user = { account: session.account, sessionId: session.session.id };
        }
      }
        return r.handler(ctx);
      };
      // Hosted (serverless): load the latest state, run, and save atomically in one transaction.
      const result = deps.transaction ? await deps.transaction(run) : await run();
      if (MUTATING.has(req.method!) || result instanceof Redirect) deps.onChange?.();
      if (result instanceof Redirect) {
        res.writeHead(result.status, { Location: result.location, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result ?? { ok: true }));
    } catch (err) {
      const status =
        err instanceof HttpError || err instanceof DriveError ? err.status
        : err instanceof CidError ? (err.code === "not_found" ? 404 : err.code === "forbidden" ? 403 : 400)
        : err instanceof MailError || err instanceof WalletError || err instanceof QuotaError ? 400
        : 500;
      if (status === 500) console.error(err);
      const code = err instanceof DriveError || err instanceof CidError || err instanceof MailError || err instanceof WalletError || err instanceof QuotaError ? err.code : undefined;
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: status === 500 ? "Something went wrong" : (err as Error).message, code }));
      }
    }
  }

  // Schedule send: anything due goes out on its own, then the stores are saved.
  const sendDue = async () => {
    const sent = await mail.sendAllDue().catch(() => 0);
    if (sent) deps.onChange?.();
    return sent;
  };
  if (!deps.noTimers) setInterval(() => void sendDue(), 20_000).unref();

  return { handle, sendDue, server: () => createServer((req, res) => void handle(req, res)) };
}
