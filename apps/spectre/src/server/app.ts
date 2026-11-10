import { serveNodeLabyrinthUI } from "@infinitum/lbrnth";
import { serveNodeDroneBackend } from "@infinitum/drone-backend";
import { serveNodeLabyrinth } from "@infinitum/lbrnth";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { CidService, CidError, cumulusCorsHeaders, loadOidcSigner, oidcDiscovery, registerProductIdp, safeProductReturn, type Account, type OidcSigner } from "@infinitum/cid";
import type { CumulusSuite } from "@infinitum/cumulus";
import { SpectreCRM, SpectreError } from "../core/crm.ts";
import { scoreDealMetatron as scoreDeal, learnedContextFor } from "../core/intelligence-metatron.ts";
import { backtestReport, industryLookup, learnedFor, DEFAULT_MODEL, LEARNED_MODEL } from "../core/metatron-learned.ts";
import { nextBestAction, forecast, riskAlerts, type Score } from "../core/intelligence.ts";
import { warmestPath, buyingCommittee, committeeGaps } from "../core/relationships.ts";
import {
  findDuplicateCompanies,
  findDuplicateContacts,
  mergeCompanies,
  mergeContactFields,
  repointReferences,
  dataIssues,
} from "../core/cleaning.ts";
import { OPEN_STAGES, STAGES } from "../core/model.ts";
import { askSpectre, aiConnected, AiNotConnected, type AiConfig } from "./ai.ts";
import { registerGrowthRoutes, type GrowthEvent } from "./growth-routes.ts";
import { registerConjureRoutes, dealSeed } from "./conjure-routes.ts";
import { registerEngageRoutes, RawResponse } from "./engage-routes.ts";
import { dispatch, runDue, type AutomationEngine } from "../core/automations.ts";
import type { Providers } from "../core/messaging.ts";
import type { Complete, ConjureLiveClient } from "@infinitum/conjure";
import { parseConjureMention, handleConjureMention, conjureLiveFromEnv, formatForecast, ConjureApiError } from "@infinitum/conjure";
import { createVeilControl, serveNodeVeil } from "@infinitum/veil/server";
import type { DeviceExitConfig, VeilServer } from "@infinitum/veil/server";
import { runLlmAgent, LlmError } from "@infinitum/scalus";
import { AGENTS, AGENT_IDS, agentDefinition, applyProposal, newProposalId, newRunId, type AgentId, type AgentRunRecord } from "../core/agent-team.ts";

/**
 * +SPCTR HTTP app. Sign-in is Cumulus://ID; access requires the "spectre" grant on the
 * person's CID, so revoking it in the CID permissions dashboard cuts Spectre off immediately.
 */

export const SPECTRE_SCOPES = ["crm:read", "crm:write"];
const COOKIE = "spctr_session";
const MAX_BODY = 1_000_000;

export interface AppDeps {
  cid: CidService;
  /** The Cumulus account suite (Mail, Cloud, FIRM Wallet) behind `cid`, when wired in. */
  suite?: CumulusSuite;
  crm: SpectreCRM;
  ai: AiConfig;
  publicDir: string;
  secureCookies: boolean;
  /** Parent domain, for example .cumuluscloud.app. Omit on localhost. */
  cookieDomain?: string;
  /** Public origin, e.g. https://spectre.infinitum.example; used for sign-in callback URLs. */
  origin: string;
  /** Called after any request that changed data (persistence hook). */
  onChange?: () => void;
  /**
   * OpenID Connect signing key. Omit to read CID_OIDC_SIGNING_KEY.
   * Null, or an unset secret, leaves discovery and signed tokens off. Sign-in still works.
   */
  oidcSigner?: OidcSigner | null;
  /**
   * Wraps each API request (hosted mode): load the latest state first, save all changes
   * atomically afterwards, and re-run the request if someone else saved in between.
   */
  transaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Automations: receives events such as form submissions and new tags. */
  emit?: (ws: string, event: GrowthEvent) => Promise<void>;
  /** Email and SMS providers (Resend, Twilio). Without them, messages are saved as drafts. */
  providers?: Providers;
  /** Shared secret the scheduler sends to resume waiting automation steps. */
  cronSecret?: string;
  /** Twilio auth token, to verify inbound SMS webhooks. */
  twilioAuthToken?: string;
  /** Tests: scripted model for Conjure simulations. */
  conjureComplete?: Complete;
  /** Hosted Conjure for "@conjure" in Ask. Defaults to CONJURE_URL + CONJURE_PRODUCT_KEY; null turns it off. */
  conjureLive?: ConjureLiveClient | null;
  /**
   * VEIL browser proxy. A plan is required for the exit and for bridges.
   * Local Tor in the extension does not call this.
   */
  veil?: {
    entitled?: (cid: string) => boolean;
    servers?: readonly VeilServer[];
    bridges?: readonly string[];
    deviceExit?: DeviceExitConfig;
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Return from a handler to send the browser elsewhere (sign-in redirects). */
class Redirect {
  readonly location: string;
  constructor(location: string) {
    this.location = location;
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: Record<string, any>;
  query: URLSearchParams;
  user?: { account: Account; workspace: string; sessionId: string };
}

type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
interface Route { method: string; pattern: RegExp; keys: string[]; auth: boolean; handler: Handler; csrf: boolean; optionalAuth: boolean; }

/** Static pages that may be shown inside other sites (iframe embeds). */
export const EMBEDDABLE = new Set(["/form.html", "/book.html"]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
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
    if (size > MAX_BODY) throw new HttpError(413, "Request too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  if (String(req.headers["content-type"] ?? "").startsWith("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
}

export function createApp(deps: AppDeps) {
  const { cid, crm } = deps;
  const oidc = deps.oidcSigner === undefined ? loadOidcSigner(process.env.CID_OIDC_SIGNING_KEY) : deps.oidcSigner;
  const providers: Providers = deps.providers ?? {};
  /** Events start matching automations, then reach any outside listener. */
  const raise = async (ws: string, event: GrowthEvent) => {
    await dispatch(engine, ws, event);
    await deps.emit?.(ws, event);
  };
  const engine: AutomationEngine = { crm, providers, raise };
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, auth = true, opts: { csrf?: boolean; optionalAuth?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
    routes.push({ method, pattern, keys, auth, handler, csrf: opts.csrf ?? true, optionalAuth: opts.optionalAuth ?? false });
  };

  const domainAttr = deps.cookieDomain ? `; Domain=${deps.cookieDomain}` : "";
  const sessionCookie = (token: string, maxAgeDays = 30) =>
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${domainAttr}${deps.secureCookies ? "; Secure" : ""}`;
  const setSession = (res: ServerResponse, token: string) => {
    res.setHeader("Set-Cookie", sessionCookie(token));
  };
  const OAUTH_COOKIE = "spctr_oauth";
  const NEXT_COOKIE = "spctr_oauth_next";
  const oauthCookie = (provider: string, value: string, maxAge: number) => {
    // Apple returns with a cross-site form POST, which only carries SameSite=None cookies.
    const sameSite = provider === "apple" && deps.secureCookies ? "None" : "Lax";
    return `${OAUTH_COOKIE}=${value}; HttpOnly; Path=/api/auth/oauth; SameSite=${sameSite}; Max-Age=${maxAge}${domainAttr}${deps.secureCookies ? "; Secure" : ""}`;
  };
  const nextCookie = (value: string, maxAge: number) =>
    `${NEXT_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${domainAttr}${deps.secureCookies ? "; Secure" : ""}`;

  const ensureGrant = async (account: Account) => {
    const ws = account.orgId ?? account.cid;
    if (!SPECTRE_SCOPES.every((s) => cid.can(account.cid, "spectre", s))) {
      await cid.grant(account.cid, "spectre", SPECTRE_SCOPES);
    }
    return ws;
  };

  const need = (ctx: Ctx, ...fields: string[]) => {
    for (const f of fields) {
      if (ctx.body[f] === undefined || ctx.body[f] === "") throw new HttpError(400, `Missing ${f}`);
    }
  };

  /* ---------------- Auth (Cumulus://ID) ---------------- */

  route("POST", "/api/auth/signup", async (ctx) => {
    need(ctx, "username");
    const account = await cid.createAccount({ username: String(ctx.body.username) });
    return { cid: account.cid, options: cid.startAuthenticatorRegistration(account.cid, "passkey") };
  }, false);

  route("POST", "/api/auth/signup/finish", async (ctx) => {
    need(ctx, "cid", "response");
    await cid.finishAuthenticatorRegistration(String(ctx.body.cid), ctx.body.response, { kind: "passkey", label: String(ctx.body.label ?? "Passkey") });
    const account = cid.getAccount(String(ctx.body.cid));
    await ensureGrant(account);
    // A just-registered passkey proves possession; sign in with it immediately.
    const options = cid.startSignIn(account.username);
    return { signedUp: true, options };
  }, false);

  route("POST", "/api/auth/signin", async (ctx) => {
    return { options: cid.startSignIn(ctx.body.username ? String(ctx.body.username) : undefined) };
  }, false);

  route("POST", "/api/auth/signin/finish", async (ctx) => {
    need(ctx, "response");
    const device = String(ctx.req.headers["user-agent"] ?? "Browser").slice(0, 120);
    const result = await cid.finishSignIn(ctx.body.response, device);
    if (result.status === "mfa_required") return result;
    setSession(ctx.res, result.token);
    await ensureGrant(cid.getAccount(result.session.cid));
    return { status: "ok" };
  }, false);

  route("POST", "/api/auth/mfa", async (ctx) => {
    need(ctx, "mfaToken", "code");
    const next = safeProductReturn(parseCookies(ctx.req.headers.cookie)[NEXT_COOKIE]);
    const { token, session } = await cid.completeMfa(String(ctx.body.mfaToken), String(ctx.body.code));
    const cookies = [sessionCookie(token)];
    if (next) cookies.push(nextCookie("", 0));
    ctx.res.setHeader("Set-Cookie", cookies);
    await ensureGrant(cid.getAccount(session.cid));
    return next ? { status: "ok", next } : { status: "ok" };
  }, false);

  route("POST", "/api/auth/signout", async (ctx) => {
    await cid.revokeSession(ctx.user!.account.cid, ctx.user!.sessionId);
    ctx.res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });

  /* ---------------- Social sign-in (Google, Apple, Microsoft, GitHub, ChatGPT, Cognito) ---------------- */

  route("GET", "/api/auth/providers", () => cid.socialProvidersEnabled(), false);

  route("GET", "/api/auth/oauth/:provider/start", async (ctx) => {
    const linking = ctx.query.get("link") === "1";
    if (linking && !ctx.user) throw new HttpError(401, "Please sign in");
    const redirectUri = `${deps.origin}/api/auth/oauth/${ctx.params.provider}/callback`;
    const { url, state } = await cid.startSocialSignIn(ctx.params.provider, redirectUri, linking ? ctx.user!.account.cid : undefined);
    const next = linking ? null : safeProductReturn(ctx.query.get("next"));
    const cookies = [oauthCookie(ctx.params.provider, state, 600)];
    if (next) cookies.push(nextCookie(next, 600));
    ctx.res.setHeader("Set-Cookie", cookies);
    return new Redirect(url);
  }, false, { optionalAuth: true });

  const oauthCallback: Handler = async (ctx) => {
    const p = ctx.req.method === "POST" ? ctx.body : Object.fromEntries(ctx.query);
    const cookiesIn = parseCookies(ctx.req.headers.cookie);
    const next = safeProductReturn(cookiesIn[NEXT_COOKIE]);
    const clearOauth = [oauthCookie(ctx.params.provider, "", 0), nextCookie("", 0)];
    ctx.res.setHeader("Set-Cookie", clearOauth);
    if (p.error) return new Redirect(`/#/signin-error/${encodeURIComponent(p.error === "access_denied" ? "Sign-in was cancelled." : "The provider couldn't sign you in.")}`);
    try {
      const device = String(ctx.req.headers["user-agent"] ?? "Browser").slice(0, 120);
      const result = await cid.finishSocialSignIn(ctx.params.provider, {
        state: String(p.state ?? ""),
        code: String(p.code ?? ""),
        browserState: cookiesIn[OAUTH_COOKIE],
      }, device);
      if (result.status === "linked") return new Redirect("/#/settings");
      if (result.status === "mfa_required") {
        if (next) ctx.res.setHeader("Set-Cookie", [oauthCookie(ctx.params.provider, "", 0), nextCookie(next, 600)]);
        return new Redirect(`/#/mfa/${result.mfaToken}`);
      }
      ctx.res.setHeader("Set-Cookie", [...clearOauth, sessionCookie(result.token)]);
      await ensureGrant(cid.getAccount(result.session.cid));
      return new Redirect(next ?? "/#/today");
    } catch (err) {
      const message = err instanceof CidError ? err.message : "Sign-in failed. Please try again.";
      if (!(err instanceof CidError)) console.error(err);
      return new Redirect(`/#/signin-error/${encodeURIComponent(message)}`);
    }
  };
  // The provider sends the browser back here, so these can't carry Spectre's request header.
  route("GET", "/api/auth/oauth/:provider/callback", oauthCallback, false, { csrf: false });
  route("POST", "/api/auth/oauth/:provider/callback", oauthCallback, false, { csrf: false });

  // Product sign-in. Without a signing key this still issues a cid and an opaque token.
  // With CID_OIDC_SIGNING_KEY it also signs ID tokens whose sub is that cid.
  registerProductIdp({
    route,
    cid,
    origin: deps.origin,
    device: (ctx) => String(ctx.req.headers["user-agent"] ?? "Browser").slice(0, 120),
    need,
    str: (v, max = 8000) => String(v ?? "").slice(0, max),
    Redirect,
    HttpError,
    signer: oidc,
  });

  route("GET", "/api/me/identities", (ctx) => ({
    linked: cid.linkedIdentities(ctx.user!.account.cid).map(({ provider, email, linkedAt }) => ({ provider, email, linkedAt })),
    available: cid.socialProvidersEnabled(),
    passkeys: cid.listAuthenticators(ctx.user!.account.cid).length,
  }));

  route("POST", "/api/me/identities/:provider/unlink", async (ctx) => {
    await cid.unlinkIdentity(ctx.user!.account.cid, ctx.params.provider);
    return { ok: true };
  });

  route("GET", "/api/me", (ctx) => {
    const a = ctx.user!.account;
    // The Cumulus account that comes with every CID: Mail (unread), Cloud storage, FIRM Wallet.
    const cumulus = deps.suite?.summary(a.cid);
    return { cid: a.cid, username: a.username, mailAddress: a.mailAddress, handle: a.handle, workspace: ctx.user!.workspace, cumulus };
  });

  /* ---------------- Today / dashboard ---------------- */

  const learnedCtx = (ws: string) => learnedContextFor(ws, crm.list("deals", ws), crm.list("activities", ws), crm.list("companies", ws));
  const scoresFor = (ws: string) => {
    const acts = crm.list("activities", ws);
    const now = crm.now();
    const learned = learnedCtx(ws);
    return new Map<string, Score>(crm.list("deals", ws).map((d) => [d.id, scoreDeal(d, acts, now, learned)]));
  };

  /* ---------------- METATRON ---------------- */

  /** Which METATRON model scores this workspace, and how close it is to a learned one. */
  const metatronStatus = (ws: string) => {
    if (process.env.USE_METATRON !== "1") return { on: false, model: "baseline" };
    const state = learnedFor(ws, crm.list("deals", ws), crm.list("activities", ws), industryLookup(crm.list("companies", ws)));
    return state.ready
      ? { on: true, model: LEARNED_MODEL, closedDeals: state.closedDeals, won: state.won, lost: state.lost }
      : { on: true, model: DEFAULT_MODEL, closedDeals: state.closedDeals, won: state.won, lost: state.lost, learning: state.reason };
  };

  route("GET", "/api/metatron", (ctx) => metatronStatus(ctx.user!.workspace));

  route("GET", "/api/metatron/backtest", (ctx) => {
    const ws = ctx.user!.workspace;
    const holdout = Number(ctx.query.get("holdout") || 0.3);
    return backtestReport(crm.list("deals", ws), crm.list("activities", ws), industryLookup(crm.list("companies", ws)), holdout > 0 && holdout < 1 ? holdout : 0.3);
  });







  route("GET", "/api/activities/summary", (ctx) => {
    const ws = ctx.user!.workspace;
    const acts = crm.list("activities", ws);
    const byKind: Record<string, number> = {};
    for (const a of acts) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
    return { total: acts.length, byKind };
  });

  route("GET", "/api/activities", (ctx) => {
    const ws = ctx.user!.workspace;
    const limit = Number(ctx.query.get("limit") || 50);
    const kind = ctx.query.get("kind");
    let acts = crm.list("activities", ws).sort((a, b) => b.at.localeCompare(a.at));
    if (kind) acts = acts.filter((a) => a.kind === kind);
    return { activities: acts.slice(0, limit) };
  });

  route("GET", "/api/search", (ctx) => {
    const q = (ctx.query.get("q") || "").toLowerCase().trim();
    if (!q) return { companies: [], contacts: [], deals: [] };
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws).filter((c) => 
      c.name.toLowerCase().includes(q) || (c.domain || "").toLowerCase().includes(q) || (c.industry || "").toLowerCase().includes(q) ||
      c.facts.some((f) => f.value.toLowerCase().includes(q) || f.field.toLowerCase().includes(q))
    ).slice(0, 10);
    const contacts = crm.list("contacts", ws).filter((c) => !c.optedOut && (
      c.name.toLowerCase().includes(q) || (c.email || "").toLowerCase().includes(q) || (c.title || "").toLowerCase().includes(q)
    )).slice(0, 10);
    const deals = crm.list("deals", ws).filter((d) => 
      d.name.toLowerCase().includes(q) || (d.market || "").toLowerCase().includes(q)
    ).slice(0, 10);
    return { companies, contacts, deals, query: q };
  });

  route("GET", "/api/pipeline/stats", (ctx) => {
    const ws = ctx.user!.workspace;
    const deals = crm.list("deals", ws);
    const byStage: Record<string, { count: number; amount: number }> = {};
    for (const d of deals) {
      byStage[d.stage] ??= { count: 0, amount: 0 };
      byStage[d.stage].count++;
      byStage[d.stage].amount += d.amount || 0;
    }
    return { byStage, total: deals.length };
  });

  route("GET", "/api/export", (ctx) => {
    const ws = ctx.user!.workspace;
    return {
      exportedAt: new Date().toISOString(),
      companies: crm.list("companies", ws),
      contacts: crm.list("contacts", ws).filter((c) => !c.optedOut),
      deals: crm.list("deals", ws),
      activities: crm.list("activities", ws).slice(0, 200),
    };
  });


  route("GET", "/api/health", () => ({
    status: "ok",
    metatron: process.env.USE_METATRON === "1",
    version: "0.1.0",
    features: ["crm", "research", "agents", "execution", "rehearse", "search", "export", "pipeline-stats", "filters", "metrics"],
  }), false);

  route("GET", "/api/metrics", (ctx) => {
    const ws = ctx.user!.workspace;
    const deals = crm.list("deals", ws);
    const companies = crm.list("companies", ws);
    const contacts = crm.list("contacts", ws);
    const open = deals.filter((d) => OPEN_STAGES.includes(d.stage));
    const byKind: Record<string, number> = {};
    const byIndustry: Record<string, number> = {};
    for (const c of companies) {
      byKind[c.kind || "unknown"] = (byKind[c.kind || "unknown"] || 0) + 1;
      if (c.industry) byIndustry[c.industry] = (byIndustry[c.industry] || 0) + 1;
    }
    return {
      companies: companies.length,
      contacts: contacts.length,
      deals: deals.length,
      openDeals: open.length,
      pipeline: open.reduce((s, d) => s + (d.amount || 0), 0),
      avgProbability: open.length ? Math.round(open.reduce((s, d) => s + (scoresFor(ws).get(d.id)?.probability || 0), 0) / open.length * 100) / 100 : 0,
      byKind,
      byIndustry,
      metatron: process.env.USE_METATRON === "1",
      metatronModel: metatronStatus(ws).model,
    };
  });

  route("GET", "/api/today", (ctx) => {
    const ws = ctx.user!.workspace;
    const deals = crm.list("deals", ws);
    const scores = scoresFor(ws);
    const acts = crm.list("activities", ws);
    const now = crm.now();
    const companies = new Map(crm.list("companies", ws).map((c) => [c.id, c.name]));
    const open = deals.filter((d) => OPEN_STAGES.includes(d.stage));
    const actions = open
      .map((d) => ({ ...nextBestAction(d, scores.get(d.id)!, acts, now), deal: d.name, company: companies.get(d.companyId), amount: d.amount, currency: d.currency }))
      .sort((a, b) => a.priority - b.priority || b.amount - a.amount);
    return {
      actions,
      alerts: riskAlerts(deals, scores),
      forecast: forecast(deals, scores, 3, now),
      totals: {
        openDeals: open.length,
        pipeline: open.reduce((s, d) => s + d.amount, 0),
        weighted: Math.round(open.reduce((s, d) => s + d.amount * (scores.get(d.id)?.probability ?? 0), 0)),
      },
    };
  });

  /* ---------------- Companies & agencies ---------------- */

  route("GET", "/api/companies", (ctx) => {
    const ws = ctx.user!.workspace;
    const deals = crm.list("deals", ws);
    const contacts = crm.list("contacts", ws);
    const industry = ctx.query.get("industry");
    let list = crm.list("companies", ws);
    if (industry) list = list.filter((c) => (c.industry || "").toLowerCase().includes(industry.toLowerCase()));
    const researched = ctx.query.get("researched");
    if (researched === "1") list = list.filter((c) => c.facts.some((f) => f.source?.includes("ai-research")));
    if (researched === "0") list = list.filter((c) => !c.facts.some((f) => f.source?.includes("ai-research")));
    const minConf = Number(ctx.query.get("minConfidence") || 0);
    if (minConf) list = list.filter((c) => c.facts.some((f) => f.source?.includes("ai-research") && ((f as any).confidence || 0) >= minConf));
    return list
      .map((c) => ({
        ...c,
        openDeals: deals.filter((d) => d.companyId === c.id && OPEN_STAGES.includes(d.stage)).length,
        contacts: contacts.filter((p) => p.companyId === c.id && !p.optedOut).length,
        researchFacts: c.facts.filter((f) => f.source?.includes("ai-research")).length,
        lastResearch: c.facts.filter((f) => f.source?.includes("ai-research")).sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0]?.observedAt,
      }))
      .sort((a, b) => {
        const sort = ctx.query.get("sort") || "name";
        if (sort === "deals") return b.openDeals - a.openDeals;
        return a.name.localeCompare(b.name);
      });
  });

  route("POST", "/api/companies", async (ctx) => {
    need(ctx, "name");
    const { name, domain, kind, industry, headcount } = ctx.body;
    return crm.addCompany(ctx.user!.workspace, ctx.user!.account.cid, { name, domain, kind, industry, headcount });
  });

  route("GET", "/api/companies/:id", (ctx) => {
    const ws = ctx.user!.workspace;
    const company = crm.company(ws, ctx.params.id);
    const contacts = crm.list("contacts", ws);
    const scores = scoresFor(ws);
    return {
      company,
      committee: buyingCommittee(company.id, contacts),
      gaps: committeeGaps(company.id, contacts),
      deals: crm.list("deals", ws).filter((d) => d.companyId === company.id).map((d) => ({ ...d, score: scores.get(d.id) })),
      activities: crm.activitiesFor(ws, { companyId: company.id }).slice(0, 50),
      warmPath: warmestPath([`cid:${ctx.user!.account.cid}`], company.id, contacts, crm.list("relationships", ws)),
    };
  });

  route("PATCH", "/api/companies/:id", (ctx) => {
    const { name, domain, kind, industry, headcount } = ctx.body;
    return crm.updateCompany(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, Object.fromEntries(Object.entries({ name, domain, kind, industry, headcount }).filter(([, v]) => v !== undefined)));
  });

  route("POST", "/api/companies/:id/facts", (ctx) => {
    need(ctx, "field", "value");
    return crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, { field: ctx.body.field, value: ctx.body.value, source: ctx.body.source || "user" });
  });

  /* ---------------- Contacts ---------------- */

  route("GET", "/api/contacts", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = new Map(crm.list("companies", ws).map((c) => [c.id, c.name]));
    return crm.list("contacts", ws).filter((c) => !c.optedOut)
      .map((c) => ({ ...c, company: c.companyId ? companies.get(c.companyId) : undefined }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  route("POST", "/api/contacts", async (ctx) => {
    need(ctx, "name");
    const { name, title, email, phone, companyId, influence } = ctx.body;
    const c = await crm.addContact(ctx.user!.workspace, ctx.user!.account.cid, { name, title, email, phone, companyId: companyId || undefined, influence: influence || undefined, source: "manual" });
    await raise(ctx.user!.workspace, { type: "contact.created", contactId: c.id });
    return c;
  });

  route("PATCH", "/api/contacts/:id", (ctx) => {
    const { name, title, email, phone, companyId, influence } = ctx.body;
    return crm.updateContact(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, Object.fromEntries(Object.entries({ name, title, email, phone, companyId, influence }).filter(([, v]) => v !== undefined)));
  });

  route("POST", "/api/contacts/:id/opt-out", async (ctx) => {
    await crm.optOut(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id);
    return { ok: true };
  });

  /* ---------------- Deals ---------------- */

  route("GET", "/api/deals", (ctx) => {
    const ws = ctx.user!.workspace;
    const scores = scoresFor(ws);
    const companies = new Map(crm.list("companies", ws).map((c) => [c.id, c.name]));
    let deals = crm.list("deals", ws);
    const min = Number(ctx.query.get("minAmount") || 0);
    if (min) deals = deals.filter((d) => (d.amount || 0) >= min);
    const stage = ctx.query.get("stage");
    if (stage) deals = deals.filter((d) => d.stage === stage);
    const closingBefore = ctx.query.get("closingBefore");
    if (closingBefore) deals = deals.filter((d) => d.closeDate && d.closeDate <= closingBefore);
    return { stages: STAGES, deals: deals.map((d) => ({ ...d, company: companies.get(d.companyId), score: scores.get(d.id) })) };
  });

  route("POST", "/api/deals", (ctx) => {
    need(ctx, "companyId", "name", "amount", "closeDate");
    const { companyId, name, amount, closeDate, market, stage, currency, contactIds } = ctx.body;
    return crm.addDeal(ctx.user!.workspace, ctx.user!.account.cid, { companyId, name, amount: Number(amount), closeDate, market, stage, currency, contactIds });
  });

  route("GET", "/api/deals/:id", async (ctx) => {
    const ws = ctx.user!.workspace;
    const deal = crm.deal(ws, ctx.params.id);
    const acts = crm.list("activities", ws);
    const score = scoreDeal(deal, acts, crm.now(), learnedCtx(ws));
    return {
      deal,
      company: crm.company(ws, deal.companyId),
      contacts: deal.contactIds.map((id) => crm.contact(ws, id)),
      score,
      next: nextBestAction(deal, score, acts, crm.now()),
      activities: crm.activitiesFor(ws, { dealId: deal.id }),
      history: (await crm.history("deal", deal.id)).map((e) => ({ at: e.timestamp, actor: e.actor, payload: e.payload, hash: e.hash })),
    };
  });

  route("PATCH", "/api/deals/:id", (ctx) => {
    const { name, amount, closeDate, market, contactIds, ownerCid } = ctx.body;
    return crm.updateDeal(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, Object.fromEntries(Object.entries({ name, amount: amount === undefined ? undefined : Number(amount), closeDate, market, contactIds, ownerCid }).filter(([, v]) => v !== undefined)));
  });

  route("POST", "/api/deals/:id/stage", async (ctx) => {
    need(ctx, "stage");
    const before = crm.deal(ctx.user!.workspace, ctx.params.id).stage;
    const d = await crm.moveDeal(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, ctx.body.stage, ctx.body.lostReason);
    if (d.stage !== before) await raise(ctx.user!.workspace, { type: "deal.stage_changed", dealId: d.id, toStage: d.stage });
    return d;
  });

  /* ---------------- Activities & relationships ---------------- */

  route("POST", "/api/activities", (ctx) => {
    need(ctx, "kind", "summary");
    const { kind, summary, dealId, companyId, contactIds, inbound, dueAt, at } = ctx.body;
    if (!["email", "call", "meeting", "note", "task"].includes(kind)) throw new HttpError(400, "Unknown activity type");
    return crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, { kind, summary, dealId: dealId || undefined, companyId: companyId || undefined, contactIds, inbound: Boolean(inbound), dueAt: dueAt || undefined, at, done: kind === "task" ? false : undefined });
  });

  route("POST", "/api/activities/:id/complete", (ctx) => crm.completeTask(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id));

  route("POST", "/api/relationships", (ctx) => {
    need(ctx, "from", "to", "strength");
    const from = ctx.body.from === "me" ? `cid:${ctx.user!.account.cid}` : String(ctx.body.from);
    const strength = Number(ctx.body.strength);
    if (![1, 2, 3, 4, 5].includes(strength)) throw new HttpError(400, "Strength is 1 to 5");
    return crm.relate(ctx.user!.workspace, ctx.user!.account.cid, from, String(ctx.body.to), strength as 1, ctx.body.note);
  });

  /* ---------------- Data health ---------------- */

  route("GET", "/api/data-health", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws);
    const contacts = crm.list("contacts", ws);
    const researched = companies.filter((c) => c.facts.some((f) => f.source?.includes("ai-research"))).length;
    return {
      duplicateCompanies: findDuplicateCompanies(companies).map((g) => ({ keep: g.keep, duplicates: g.duplicates, reason: g.reason })),
      duplicateContacts: findDuplicateContacts(contacts).map((g) => ({ keep: g.keep, duplicates: g.duplicates, reason: g.reason })),
      issues: dataIssues(contacts, companies, crm.list("activities", ws), crm.now()),
      researchCoverage: companies.length ? Math.round(researched / companies.length * 100) : 0,
    };
  });

  route("POST", "/api/data-health/merge", async (ctx) => {
    need(ctx, "kind", "keepId", "mergeIds");
    const ws = ctx.user!.workspace;
    const kind = ctx.body.kind as "company" | "contact";
    const keepId = String(ctx.body.keepId);
    const mergeIds = (ctx.body.mergeIds as string[]).map(String).filter((id) => id !== keepId);
    if (kind === "contact") {
      const keep = crm.contact(ws, keepId);
      const dups = mergeIds.map((id) => crm.contact(ws, id));
      crm.store.contacts.set(keepId, { ...mergeContactFields(keep, dups), updatedAt: crm.now().toISOString() });
      dups.forEach((d) => crm.store.contacts.delete(d.id));
      repointReferences(keepId, mergeIds, crm.list("deals", ws), crm.list("activities", ws));
      await crm.recordMerge(ctx.user!.account.cid, kind, keepId, mergeIds);
    } else if (kind === "company") {
      await mergeCompanies(crm, ws, ctx.user!.account.cid, keepId, mergeIds);
    } else throw new HttpError(400, "kind is company or contact");
    return { ok: true };
  });

  /* ---------------- Ask in plain language ---------------- */

  // "@conjure <question>" in Ask starts a live Conjure forecast instead of a plain answer.
  const conjureLive = deps.conjureLive === undefined ? conjureLiveFromEnv() : deps.conjureLive;
  const livePredictions = new Map<string, string>(); // prediction id -> workspace that asked

  route("POST", "/api/ask", async (ctx) => {
    need(ctx, "question");
    const ws = ctx.user!.workspace;
    if (parseConjureMention(String(ctx.body.question))) {
      if (!conjureLive) throw new HttpError(503, "Conjure isn't connected. Set CONJURE_URL and CONJURE_PRODUCT_KEY to use @conjure.");
      // On a deal, the forecast is seeded with everything +SPCTR knows about it.
      const deal = typeof ctx.body.dealId === "string" ? dealSeed(crm, ws, ctx.body.dealId).seed : "";
      try {
        const out = await handleConjureMention(conjureLive, String(ctx.body.question).slice(0, 2000), { context: deal, user: ctx.user!.account.cid, source: deal ? "deal" : "ask", wait: false });
        if (out!.prediction) livePredictions.set(out!.prediction.id, ws);
        return { answer: out!.text, conjure: out!.prediction };
      } catch (err) {
        if (err instanceof ConjureApiError) throw new HttpError(err.status === 429 ? 429 : 502, err.message);
        throw err;
      }
    }
    const scores = scoresFor(ws);
    const companies = crm.list("companies", ws);
    const names = new Map(companies.map((c) => [c.id, c.name]));
    const context = {
      today: crm.now().toISOString().slice(0, 10),
      companies: companies.map((c) => ({ name: c.name, kind: c.kind, industry: c.industry, facts: c.facts.map((f) => `${f.field}: ${f.value}`) })),
      deals: crm.list("deals", ws).map((d) => ({ name: d.name, company: names.get(d.companyId), market: d.market, stage: d.stage, amount: d.amount, currency: d.currency, closeDate: d.closeDate, winProbability: scores.get(d.id)?.probability, risks: scores.get(d.id)?.factors.filter((f) => f.effect < 1).map((f) => f.label) })),
      contacts: crm.list("contacts", ws).filter((c) => !c.optedOut).map((c) => ({ name: c.name, title: c.title, company: c.companyId ? names.get(c.companyId) : undefined, role: c.influence })),
      recentActivity: crm.list("activities", ws).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80).map((a) => ({ at: a.at.slice(0, 10), kind: a.kind, summary: a.summary, company: a.companyId ? names.get(a.companyId) : undefined, inbound: a.inbound, done: a.done })),
    };
    try {
      return { answer: await askSpectre(deps.ai, String(ctx.body.question).slice(0, 2000), context) };
    } catch (err) {
      if (err instanceof AiNotConnected) throw new HttpError(503, err.message);
      throw new HttpError(502, (err as Error).message);
    }
  });


  /** Follow a live @conjure forecast started from Ask (only from the workspace that asked). */
  route("GET", "/api/conjure/live/:id", async (ctx) => {
    if (!conjureLive || livePredictions.get(ctx.params.id) !== ctx.user!.workspace) throw new HttpError(404, "No such forecast");
    const prediction = await conjureLive.get(ctx.params.id);
    return { prediction, text: formatForecast(prediction) };
  });

  /* ---------------- Research & Agents ---------------- */


  route("POST", "/api/companies/:id/research", async (ctx) => {
    const company = crm.company(ctx.user!.workspace, ctx.params.id);
    const { researchCompany } = await import("./research.ts") as any;
    const result = await researchCompany(company.name) as any;
    let persisted = 0;
    if (result && Array.isArray(result.facts)) {
      const existing = new Set(company.facts.map((f) => `${f.field}:${f.value}`));
      for (const fact of result.facts.slice(0, 5)) {
        if (fact.field && fact.value && !existing.has(`${fact.field}:${fact.value}`)) {
          await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, company.id, {
            field: fact.field,
            value: fact.value,
            source: fact.source || "ai-research",
          });
          existing.add(`${fact.field}:${fact.value}`);
          persisted++;
        }
      }
    }
    if (persisted > 0) {
      await crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, {
        kind: "note",
        summary: `AI research added ${persisted} facts`,
        companyId: company.id,
      });
    }
    return { ...result, persisted };
  });

  route("POST", "/api/research", async (ctx) => {
    need(ctx, "name");
    const { researchCompany } = await import("./research.ts") as any;
    let result;
    try {
      result = await researchCompany(String(ctx.body.name));
    } catch (e) {
      return { error: String(e), facts: [] };
    }
    // Persist any returned facts to the company if companyId provided
    if (ctx.body.companyId && result && Array.isArray(result.facts)) {
      const existing = new Set(crm.company(ctx.user!.workspace, String(ctx.body.companyId)).facts.map((f) => `${f.field}:${f.value}`));
      for (const fact of result.facts.slice(0, 5)) {
        if (fact.field && fact.value && !existing.has(`${fact.field}:${fact.value}`)) {
          await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, String(ctx.body.companyId), {
            field: fact.field,
            value: fact.value,
            source: fact.source || "ai-research",
          });
          existing.add(`${fact.field}:${fact.value}`);
        }
      }
    }
    const persisted = (ctx.body.companyId && result && Array.isArray(result.facts)) ? result.facts.filter((f: any) => f.field && f.value).length : 0;
    if (persisted > 0 && ctx.body.companyId) {
      await crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, {
        kind: "note",
        summary: `AI research added ${persisted} facts`,
        companyId: String(ctx.body.companyId),
      });
    }
    return { ...result, persisted };
  });



  route("POST", "/api/research/contact", async (ctx) => {
    need(ctx, "name");
    const { researchCompany } = await import("./research.ts") as any;
    const result = await researchCompany(`${ctx.body.name} ${ctx.body.company || ""}`.trim()) as any;
    return result;
  });








  route("GET", "/api/research/queue/stats", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws);
    const queued = companies.filter((c) => c.facts.some((f) => f.source === "research-queue") && !c.facts.some((f) => f.source === "research-queue-done"));
    const done = companies.filter((c) => c.facts.some((f) => f.source === "research-queue-done"));
    return {
      queued: queued.length,
      done: done.length,
      total: companies.length,
    };
  });

  route("POST", "/api/research/queue/process", async (ctx) => {
    const { researchCompany } = await import("./research.ts") as any;
    const companies = crm.list("companies", ctx.user!.workspace);
    const queued = companies.filter((c) => c.facts.some((f) => f.source === "research-queue")).slice(0, 5);
    const results = [];
    for (const c of queued) {
      try {
        const result = await researchCompany(c.name) as any;
        let persisted = 0;
        if (result && Array.isArray(result.facts)) {
          const existing = new Set(c.facts.map((f) => `${f.field}:${f.value}`));
          for (const fact of result.facts.slice(0, 5)) {
            if (fact.field && fact.value && !existing.has(`${fact.field}:${fact.value}`)) {
              await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, c.id, {
                field: fact.field,
                value: fact.value,
                source: fact.source || "ai-research-queue",
              });
              existing.add(`${fact.field}:${fact.value}`);
              persisted++;
            }
          }
        }
        if (persisted > 0) {
          await crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, {
            kind: "note",
            summary: `Queue research added ${persisted} facts`,
            companyId: c.id,
          });
        }
        if (persisted > 0) {
          await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, c.id, {
            field: "research-queue",
            value: "done",
            source: "research-queue-done",
          });
        }
        results.push({ id: c.id, name: c.name, persisted, done: persisted > 0 });
      } catch (e) {
        results.push({ id: c.id, name: c.name, error: String(e) });
      }
    }
    return { processed: results.length, results };
  });

  route("POST", "/api/research/queue/remove", async (ctx) => {
    need(ctx, "companyId");
    const id = String(ctx.body.companyId);
    const company = crm.company(ctx.user!.workspace, id);
    // Mark as processed by adding a done fact (simple approach)
    await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, id, {
      field: "research-queue",
      value: "done",
      source: "research-queue-done",
    });
    return { removed: true, companyId: id, name: company.name };
  });

  route("POST", "/api/research/queue", async (ctx) => {
    need(ctx, "companyId");
    const id = String(ctx.body.companyId);
    const company = crm.company(ctx.user!.workspace, id);
    await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, id, {
      field: "research-queue",
      value: "queued",
      source: "research-queue",
    });
    return { queued: true, companyId: id, name: company.name };
  });

  route("GET", "/api/research/queue", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws);
    const now = Date.now();
    const queue = companies
      .map((c) => {
        const ai = c.facts.filter((f) => f.source?.includes("ai-research"));
        const last = ai.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        const age = last ? Math.floor((now - Date.parse(last.observedAt)) / 86400000) : 999;
        const manual = c.facts.some((f) => f.source === "research-queue") && !c.facts.some((f) => f.source === "research-queue-done");
        const score = (manual ? 100 : 0) + (ai.length < 2 ? 50 : 0) + (age > 30 ? 30 : age > 7 ? 10 : 0);
        return { id: c.id, name: c.name, factCount: ai.length, ageDays: age, priority: score, manual };
      })
      .filter((c) => c.priority > 0)
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 15);
    return { queue };
  });

  route("GET", "/api/research/recommendations", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws);
    const now = Date.now();
    const recommendations = companies
      .map((c) => {
        const aiFacts = c.facts.filter((f) => f.source?.includes("ai-research"));
        const last = aiFacts.sort((a, b) => b.observedAt.localeCompare(a.observedAt))[0];
        const ageDays = last ? Math.floor((now - Date.parse(last.observedAt)) / 86400000) : 999;
        const needs = aiFacts.length < 2 || ageDays > 30;
        return needs ? { id: c.id, name: c.name, factCount: aiFacts.length, ageDays, reason: aiFacts.length < 2 ? "low coverage" : "stale" } : null;
      })
      .filter(Boolean)
      .slice(0, 10);
    return { recommendations };
  });

  route("GET", "/api/research/history", (ctx) => {
    const ws = ctx.user!.workspace;
    const limit = Number(ctx.query.get("limit") || 20);
    const companies = crm.list("companies", ws);
    const history = [];
    for (const c of companies) {
      for (const f of c.facts.filter((x) => x.source?.includes("ai-research")).slice(0, 3)) {
        history.push({ companyId: c.id, company: c.name, field: f.field, value: f.value, at: f.observedAt, source: f.source });
      }
    }
    history.sort((a, b) => b.at.localeCompare(a.at));
    return { history: history.slice(0, limit) };
  });

  route("GET", "/api/research/status", (ctx) => {
    const ws = ctx.user!.workspace;
    const companies = crm.list("companies", ws);
    const researched = companies.filter((c) => c.facts.some((f) => f.source?.includes("ai-research")));
    const confs = researched.flatMap((c) => c.facts.filter((f) => f.source?.includes("ai-research") && (f as any).confidence).map((f) => (f as any).confidence));
    const avgConf = confs.length ? Math.round(confs.reduce((a, b) => a + b, 0) / confs.length * 100) / 100 : 0;
    return {
      total: companies.length,
      researched: researched.length,
      coverage: companies.length ? Math.round(researched.length / companies.length * 100) : 0,
      recent: researched.filter((c) => c.facts.some((f) => f.source?.includes("ai-research") && Date.now() - Date.parse(f.observedAt) < 86400000 * 7)).length,
      avgConfidence: avgConf,
      lowConfidence: confs.filter((c) => c < 0.6).length,
      highConfidence: confs.filter((c) => c >= 0.7).length,
      totalFacts: confs.length,
    };
  });

  route("POST", "/api/research/all", async (ctx) => {
    const { researchCompany } = await import("./research.ts") as any;
    const companies = crm.list("companies", ctx.user!.workspace);
    const results = [];
    for (const c of companies.slice(0, 10)) { // limit to avoid long runs
      try {
        // Skip if has recent AI research facts (last 24h)
        const recent = c.facts.some((f) => f.source?.includes("ai-research") && Date.now() - Date.parse(f.observedAt) < 86400000);
        if (recent) {
          results.push({ id: c.id, name: c.name, skipped: "recent research" });
          continue;
        }
        const result = await researchCompany(c.name) as any;
        let persisted = 0;
        if (result && Array.isArray(result.facts)) {
          for (const fact of result.facts.slice(0, 5)) {
            if (fact.field && fact.value) {
              await crm.addFact(ctx.user!.workspace, ctx.user!.account.cid, c.id, {
                field: fact.field,
                value: fact.value,
                source: fact.source || "ai-research-bulk",
              });
              persisted++;
            }
          }
        }
        if (persisted > 0) {
          await crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, {
            kind: "note",
            summary: `Bulk AI research added ${persisted} facts`,
            companyId: c.id,
          });
        }
        results.push({ id: c.id, name: c.name, persisted, summary: result?.summary });
      } catch (e) {
        results.push({ id: c.id, name: c.name, error: String(e) });
      }
    }
    return { researched: results.length, results };
  });

  route("POST", "/api/query", async (ctx) => {
    need(ctx, "text");
    const { handleQuery } = await import("./query.ts");
    const result = await handleQuery(String(ctx.body.text), { crm, workspace: ctx.user!.workspace });
    return result;
  });


  /* ---------------- SCALVS.ai agents ---------------- */

  const agentCtx = (ctx: Ctx) => ({ crm, workspace: ctx.user!.workspace });

  /** Run one SCALVS.ai agent on the workspace; store its proposals for approval. */
  async function runTeamAgent(ctx: Ctx, agentId: string, prompt: string) {
    if (!aiConnected(deps.ai)) throw new HttpError(503, new AiNotConnected().message);
    const ws = ctx.user!.workspace;
    const def = agentDefinition(agentId, agentCtx(ctx), crm.now().toISOString().slice(0, 10));
    if (!def) throw new HttpError(404, "No such agent");
    let result;
    try {
      result = await runLlmAgent({ router: deps.ai.router, newId: newProposalId }, def, prompt);
    } catch (err) {
      if (err instanceof LlmError) throw new HttpError(502, err.status === 429 ? "The AI is busy right now. Please try again in a minute." : "The AI service couldn't complete this run. Please try again.");
      throw err;
    }
    const at = crm.now().toISOString();
    const by = ctx.user!.account.cid;
    for (const p of result.proposals) {
      crm.store.proposals.set(p.id, { ...p, workspace: ws, agentId: agentId as AgentId, status: "pending", requestedBy: by, createdAt: at });
    }
    const run: AgentRunRecord = { id: newRunId(), workspace: ws, agentId: agentId as AgentId, prompt: prompt.slice(0, 2000), output: result.output, steps: result.steps, proposalIds: result.proposals.map((p) => p.id), requestedBy: by, at, usage: result.usage };
    crm.store.agentRuns.set(run.id, run);
    // Keep the 50 most recent runs per workspace.
    const runs = crm.list("agentRuns", ws).sort((a, b) => b.at.localeCompare(a.at));
    for (const old of runs.slice(50)) crm.store.agentRuns.delete(old.id);
    await crm.auditAgent(by, agentId, { event: "agent.run", run: run.id, proposals: run.proposalIds.length, tools: [...new Set(result.steps.map((s) => s.tool))] });
    return { run, proposals: run.proposalIds.map((id) => crm.store.proposals.get(id)) };
  }

  route("GET", "/api/agents", (ctx) => ({
    aiConnected: aiConnected(deps.ai),
    agents: AGENT_IDS.map((id) => ({ id, name: AGENTS[id].name, role: AGENTS[id].role, starters: AGENTS[id].starters, canPropose: AGENTS[id].propose })),
    pending: crm.list("proposals", ctx.user!.workspace).filter((p) => p.status === "pending").length,
  }));

  route("POST", "/api/agents/:id/run", async (ctx) => {
    const prompt = String(ctx.body.prompt ?? "").trim();
    if (!prompt) throw new HttpError(400, "Tell the agent what to do");
    return runTeamAgent(ctx, ctx.params.id, prompt);
  });

  route("GET", "/api/agents/runs", (ctx) =>
    crm.list("agentRuns", ctx.user!.workspace).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20));

  route("GET", "/api/agents/proposals", (ctx) => {
    const status = ctx.query.get("status") ?? "pending";
    return crm.list("proposals", ctx.user!.workspace).filter((p) => status === "all" || p.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  });

  route("POST", "/api/agents/proposals/:id/:decision", async (ctx) => {
    const ws = ctx.user!.workspace;
    const p = crm.store.proposals.get(ctx.params.id);
    if (!p || p.workspace !== ws) throw new HttpError(404, "Proposal not found");
    if (p.status !== "pending") throw new HttpError(409, `Already ${p.status}`);
    const decision = ctx.params.decision;
    if (decision !== "approve" && decision !== "dismiss") throw new HttpError(404, "Not found");
    const by = ctx.user!.account.cid;
    let resultId: string | undefined;
    if (decision === "approve") {
      try {
        resultId = await applyProposal(crm, ws, by, p);
      } catch (err) {
        throw new HttpError(400, `Couldn't apply this: ${(err as Error).message}`);
      }
    }
    const updated = { ...p, status: decision === "approve" ? "approved" as const : "dismissed" as const, decidedBy: by, decidedAt: crm.now().toISOString(), resultId };
    crm.store.proposals.set(p.id, updated);
    await crm.auditAgent(by, p.agentId, { event: `proposal.${updated.status}`, proposal: p.id, tool: p.tool, result: resultId ?? null });
    if (decision === "approve" && p.tool === "move_deal" && resultId) {
      await raise(ws, { type: "deal.stage_changed", dealId: resultId, toStage: crm.deal(ws, resultId).stage });
    }
    return updated;
  });

  /** Deal Rehearsal: the Deal coach plays out the next meeting from the deal's records. */
  route("POST", "/api/rehearse", async (ctx) => {
    need(ctx, "dealId");
    const deal = crm.deal(ctx.user!.workspace, String(ctx.body.dealId));
    return runTeamAgent(ctx, "deal-coach",
      `Rehearse my next meeting on the deal "${deal.name}" (dealId ${deal.id}). Build the buying committee from the records, play out how the conversation is likely to go, list the likely objections with a response to each, and say who still needs convincing. Mark clearly what is an assumption. Propose a task for the most important preparation step.`);
  });

  route("POST", "/api/prospect", async (ctx) =>
    runTeamAgent(ctx, "prospector", "Find up to 5 new prospects that match our best customers. Propose adding each with the reason it fits."));

  route("GET", "/api/execution/pending", async (ctx) => {
    const { listPendingActions } = await import("./execution.ts");
    return { pending: await listPendingActions(crm, ctx.user!.workspace) };
  });

  route("POST", "/api/execution/run", async (ctx) => {
    const { executeAll } = await import("../core/architect-bridge.ts");
    const { listPendingActions } = await import("./execution.ts");
    const pending = await listPendingActions(crm, ctx.user!.workspace);
    const results = await executeAll(pending, { crm, workspace: ctx.user!.workspace, actor: ctx.user!.account.cid } as any);
    // Log executed actions as activities
    for (const r of results || []) {
      const dealId = (r as any)?.dealId;
      if (dealId) {
        await crm.logActivity(ctx.user!.workspace, ctx.user!.account.cid, {
          kind: "note",
          summary: `AI action: ${(r as any).description || (r as any).type || "executed"}`,
          dealId,
        });
      }
    }
    return { results, logged: results?.length || 0 };
  });

  /* ---------------- Growth: contacts+, forms, calendars, automations, conversations ---------------- */

  registerGrowthRoutes({
    route,
    crm,
    httpError: (status, message) => new HttpError(status, message),
    emit: raise,
  });

  registerEngageRoutes({
    route, crm, engine, providers,
    httpError: (status, message) => new HttpError(status, message),
    cronSecret: deps.cronSecret,
    twilioAuthToken: deps.twilioAuthToken,
    origin: deps.origin,
  });

  registerConjureRoutes({ route, crm, ai: deps.ai, httpError: (status, message) => new HttpError(status, message), complete: deps.conjureComplete });

  const veilControl = createVeilControl({
    cid: deps.cid,
    entitled: deps.veil?.entitled,
    servers: deps.veil?.servers,
    bridges: deps.veil?.bridges,
    deviceExit: deps.veil?.deviceExit,
  });

  /* ---------------- Request handling ---------------- */

  const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

  async function serveStatic(pathname: string, res: ServerResponse) {
    const rel = pathname === "/" || !extname(pathname) ? "index.html" : pathname.slice(1);
    const file = normalize(join(deps.publicDir, rel));
    if (!file.startsWith(normalize(deps.publicDir))) throw new HttpError(404, "Not found");
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
        "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=300",
      });
      res.end(data);
    } catch {
      throw new HttpError(404, "Not found");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    const url = new URL(req.url ?? "/", "http://localhost");
    // Public form and booking pages can be embedded on other sites; everything else can't be framed.
    const embeddable = EMBEDDABLE.has(url.pathname);
    if (!embeddable) res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api2.amplitude.com https://api.amplitude.com; frame-ancestors ${embeddable ? "*" : "'none'"}`);
    const requestOrigin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const cors = cumulusCorsHeaders(requestOrigin);
    for (const [name, value] of Object.entries(cors)) res.setHeader(name, value);
    if (req.method === "OPTIONS" && cors["Access-Control-Allow-Origin"]) {
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    try {
      if (url.pathname === "/labyrinth" || url.pathname.startsWith("/labyrinth/")) return await serveNodeLabyrinthUI(req, res);
      if (url.pathname === "/api/labyrinth") return await serveNodeLabyrinth(req, res, deps.suite?.labyrinth, parseCookies(req.headers.cookie)[COOKIE], deps.onChange);
      if (url.pathname.startsWith("/api/drones/")) return await serveNodeDroneBackend(req, res, deps.suite?.labyrinth, deps.origin);
      if (url.pathname.startsWith("/api/veil/")) return await serveNodeVeil(req, res, veilControl, deps.origin);
      const oidcDocument = url.pathname === "/.well-known/openid-configuration"
        || url.pathname === "/.well-known/jwks.json"
        || url.pathname === "/realms/cumulus/.well-known/openid-configuration"
        || url.pathname === "/realms/cumulus/protocol/openid-connect/certs";
      if (oidc && (req.method === "GET" || req.method === "HEAD") && oidcDocument) {
        const body = url.pathname.endsWith("/certs") || url.pathname.endsWith("/jwks.json")
          ? JSON.stringify({ keys: [oidc.publicJwk()] })
          : JSON.stringify(oidcDiscovery(cid.issuer, oidc.alg));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        });
        if (req.method === "HEAD") res.end();
        else res.end(body);
        return;
      }
      // These paths have no file extension, so the static handler would serve the app.
      // With no signing key they stay absent: OpenID Connect is off.
      if (!oidc && (oidcDocument || url.pathname.startsWith("/realms/"))) throw new HttpError(404, "Not found");
      const oidcRoute = Boolean(oidc) && url.pathname.startsWith("/realms/cumulus/");
      if (!url.pathname.startsWith("/api/") && !oidcRoute) {
        if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
        return await serveStatic(url.pathname, res);
      }
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) throw new HttpError(404, "Not found");
      // CSRF: state-changing calls must come from Spectre's own script (custom header + JSON).
      if (r.csrf && MUTATING.has(req.method!) && req.headers["x-spectre"] !== "1") throw new HttpError(403, "Missing request header");
      const m = url.pathname.match(r.pattern)!;
      const ctx: Ctx = { req, res, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), body: await readBody(req), query: url.searchParams };
      // Authentication runs inside the transaction so it sees the latest sessions and grants.
      const run = async () => {
        ctx.user = undefined;
        if (r.auth || r.optionalAuth) {
          const token = parseCookies(req.headers.cookie)[COOKIE];
          const session = token ? cid.authenticate(token) : null;
          if (!session && r.auth) throw new HttpError(401, "Please sign in");
          if (session) {
            if (r.auth) {
              const scope = MUTATING.has(req.method!) ? "crm:write" : "crm:read";
              if (!cid.can(session.account.cid, "spectre", scope)) throw new HttpError(403, "Spectre's access was revoked in your Cumulus://ID permissions");
            }
            ctx.user = { account: session.account, workspace: session.account.orgId ?? session.account.cid, sessionId: session.session.id };
          }
        }
        return r.handler(ctx);
      };
      const result = deps.transaction ? await deps.transaction(run) : await run();
      if (MUTATING.has(req.method!) || result instanceof Redirect) deps.onChange?.();
      if (result instanceof RawResponse) {
        res.writeHead(result.status, { "Content-Type": result.contentType, "Cache-Control": "no-store" });
        res.end(result.body);
        return;
      }
      if (result instanceof Redirect) {
        res.writeHead(302, { Location: result.location, "Cache-Control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(result ?? { ok: true }));
    } catch (err) {
      const status = err instanceof HttpError ? err.status
        : err instanceof CidError ? (["not_found"].includes(err.code) ? 404 : err.code === "forbidden" ? 403 : 400)
        : err instanceof SpectreError ? (err.code === "not_found" ? 404 : err.code === "inactive" ? 410 : err.code === "slot_taken" || err.code === "opted_out" ? 409 : 400)
        : 500;
      if (status === 500) console.error(err);
      const code = err instanceof CidError || err instanceof SpectreError ? err.code : undefined;
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: status === 500 ? "Something went wrong" : (err as Error).message, code }));
      }
    }
  }

  /** Resume automation steps whose wait is over (local timer; hosted mode uses the cron endpoint). */
  const runDueAutomations = async () => {
    const run = () => runDue(engine);
    const n = deps.transaction ? await deps.transaction(run) : await run();
    if (n) deps.onChange?.();
    return n;
  };

  return { handle, runDueAutomations, server: () => createServer((req, res) => void handle(req, res)) };
}
