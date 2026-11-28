/**
 * HTTP routes for FABRIC++ team chat, under /api/team, plus a live event stream.
 *
 * Live events (GET /api/team/events, Server-Sent Events) carry ids only, never
 * message text: the page fetches what changed through the normal routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { FabricIdentity } from "./auth.ts";
import { FabricServiceError } from "./service.ts";
import { TEAM_LIMITS, type TeamEvent, type TeamService } from "./team.ts";

export interface TeamActor {
  identity: FabricIdentity;
  bearer: boolean;
}

export interface TeamHttpContext {
  team: TeamService;
  hub: TeamHub;
  security: Record<string, string>;
  authenticate: (req: IncomingMessage) => Promise<TeamActor>;
  assertMutation: (req: IncomingMessage, actor: TeamActor) => void;
  readJson: (req: IncomingMessage, limit: number) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  allow: (key: string, max: number, windowMs: number) => boolean;
}

const ID = "([0-9a-fA-F-]{36})";
const NAME = "([a-z0-9._-]{1,64})";
const BODY_LIMIT = 64 * 1024;
const FILE_BODY_LIMIT = Math.ceil(TEAM_LIMITS.fileBytes * 1.4) + 4096;
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
const EMOJI = "([a-z0-9_+-]{1,40})";
const EMOJI_BODY_LIMIT = Math.ceil(TEAM_LIMITS.emojiBytes * 1.4) + 4096;

type Handler = (c: Call) => unknown | Promise<unknown>;
interface Call {
  team: TeamService;
  security: Record<string, string>;
  me: FabricIdentity;
  params: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  req: IncomingMessage;
  res: ServerResponse;
}
interface Route { method: string; pattern: RegExp; handler: Handler; status?: number; limit?: number; raw?: boolean; bucket?: { name: string; max: number } }

/** Fan-out of live events to connected browsers. */
export class TeamHub {
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private onChange: (sub: string, delta: 1 | -1) => void = () => {};

  watch(onChange: (sub: string, delta: 1 | -1) => void): void {
    this.onChange = onChange;
  }

  publish = (subs: string[], event: TeamEvent): void => {
    const payload = `event: team\ndata: ${JSON.stringify(event)}\n\n`;
    for (const sub of new Set(subs)) for (const res of this.clients.get(sub) ?? []) res.write(payload);
  };

  connections(sub: string): number {
    return this.clients.get(sub)?.size ?? 0;
  }

  attach(sub: string, req: IncomingMessage, res: ServerResponse, security: Record<string, string>): void {
    if (this.connections(sub) >= 8) throw new FabricServiceError(429, "too many open tabs");
    res.writeHead(200, { ...security, "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no", connection: "keep-alive" });
    res.write(`retry: 3000\nevent: ready\ndata: {}\n\n`);
    const set = this.clients.get(sub) ?? new Set();
    set.add(res);
    this.clients.set(sub, set);
    this.onChange(sub, 1);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    ping.unref();
    const done = () => {
      clearInterval(ping);
      if (!set.delete(res)) return;
      if (set.size === 0) this.clients.delete(sub);
      this.onChange(sub, -1);
    };
    req.on("close", done);
    res.on("close", done);
  }
}

export function teamRoutes(): Route[] {
  const r = (method: string, path: string, handler: Handler, extra: Partial<Route> = {}): Route => ({
    method, pattern: new RegExp(`^/api/team${path}$`), handler, ...extra,
  });
  return [
    r("GET", "/workspaces", ({ team, me }) => ({ workspaces: team.listWorkspaces(me) })),
    r("POST", "/workspaces", ({ team, me, body }) => team.createWorkspace(me, str(body.name)), { status: 201 }),
    r("POST", "/join", ({ team, me, body }) => team.joinWorkspace(me, str(body.code))),
    r("GET", `/workspaces/${ID}`, ({ team, me, params }) => team.sidebar(me, params[0]!)),
    r("PATCH", `/workspaces/${ID}`, ({ team, me, params, body }) => team.updateWorkspace(me, params[0]!, body)),
    r("GET", `/workspaces/${ID}/people`, ({ team, me, params, query }) => ({ people: team.people(me, params[0]!, query.get("q") ?? "") })),
    r("PATCH", `/workspaces/${ID}/me`, ({ team, me, params, body }) => team.updateProfile(me, params[0]!, body)),
    r("PUT", `/workspaces/${ID}/status`, ({ team, me, params, body }) => team.setStatus(me, params[0]!, body)),
    r("PUT", `/workspaces/${ID}/retention`, ({ team, me, params, body }) => team.setRetention(me, params[0]!, body.days)),
    r("PUT", `/workspaces/${ID}/presence`, ({ team, me, params, body }) => team.setPresence(me, params[0]!, body)),
    r("PUT", `/workspaces/${ID}/people/${NAME}/role`, ({ team, me, params, body }) => team.setRole(me, params[0]!, params[1]!, body.role)),
    r("DELETE", `/workspaces/${ID}/people/${NAME}`, ({ team, me, params }) => team.removeMember(me, params[0]!, params[1]!)),
    r("GET", `/workspaces/${ID}/channels`, ({ team, me, params, query }) => ({ channels: team.browseChannels(me, params[0]!, query.get("q") ?? "", query.get("archived") === "1") })),
    r("POST", `/workspaces/${ID}/channels`, ({ team, me, params, body }) => team.createChannel(me, params[0]!, body), { status: 201 }),
    r("POST", `/workspaces/${ID}/conversations`, ({ team, me, params, body }) => team.openConversation(me, params[0]!, body.people ?? [])),
    r("GET", `/workspaces/${ID}/activity`, ({ team, me, params }) => ({ items: team.activity(me, params[0]!) })),
    r("GET", `/workspaces/${ID}/threads`, ({ team, me, params }) => ({ threads: team.threads(me, params[0]!) })),
    r("GET", `/workspaces/${ID}/unreads`, ({ team, me, params }) => ({ unreads: team.unreads(me, params[0]!) })),
    r("GET", `/workspaces/${ID}/saved`, ({ team, me, params, query }) => ({ saved: team.saved(me, params[0]!, query.get("done") === "1") })),
    r("GET", `/workspaces/${ID}/files`, ({ team, me, params, query }) => ({ files: team.files(me, params[0]!, query.get("channel") ?? undefined) })),
    r("GET", `/workspaces/${ID}/search`, ({ team, me, params, query }) => team.search(me, params[0]!, query.get("q") ?? "")),
    r("GET", `/workspaces/${ID}/groups`, ({ team, me, params }) => ({ groups: team.groups(me, params[0]!) })),
    r("POST", `/workspaces/${ID}/groups`, ({ team, me, params, body }) => team.saveGroup(me, params[0]!, body)),
    r("DELETE", `/workspaces/${ID}/groups/${NAME}`, ({ team, me, params }) => team.deleteGroup(me, params[0]!, params[1]!)),
    r("GET", `/workspaces/${ID}/export`, ({ team, me, params, query, res, security }) => {
      const data = team.exportWorkspace(me, params[0]!, { includePrivate: query.get("private") === "1" });
      const body = Buffer.from(JSON.stringify(data, null, 2));
      const day = data.exportedAt.slice(0, 10);
      res.writeHead(200, {
        ...security,
        "content-type": "application/json; charset=utf-8",
        "content-length": body.length,
        "content-disposition": `attachment; filename="${data.workspace.slug}-export-${day}.json"`,
        "cache-control": "no-store",
      });
      res.end(body);
    }, { raw: true }),
    r("GET", `/workspaces/${ID}/webhooks`, ({ team, me, params }) => ({ webhooks: team.webhooks(me, params[0]!) })),
    r("GET", `/workspaces/${ID}/notification-schedule`, ({ team, me, params }) => ({ schedule: team.notifySchedule(me, params[0]!) })),
    r("PUT", `/workspaces/${ID}/notification-schedule`, ({ team, me, params, body }) => ({ schedule: team.setNotifySchedule(me, params[0]!, body.schedule ?? null) })),
    r("GET", `/workspaces/${ID}/drafts`, ({ team, me, params }) => ({ drafts: team.drafts(me, params[0]!) })),
    r("PUT", `/channels/${ID}/draft`, ({ team, me, params, body }) => ({ draft: team.saveDraft(me, params[0]!, body) })),
    r("GET", `/workspaces/${ID}/scheduled`, ({ team, me, params }) => ({ scheduled: team.scheduledList(me, params[0]!) })),
    r("GET", `/workspaces/${ID}/reminders`, ({ team, me, params }) => ({ reminders: team.reminders(me, params[0]!) })),
    r("POST", `/workspaces/${ID}/reminders`, ({ team, me, params, body }) => team.remind(me, params[0]!, body.text, body.at), { status: 201 }),

    r("GET", `/channels/${ID}`, ({ team, me, params }) => team.getChannel(me, params[0]!)),
    r("GET", `/channels/${ID}/insights`, ({ team, me, params, query }) => team.insights(me, params[0]!, query.get("days") ?? 30)),
    r("PATCH", `/channels/${ID}`, ({ team, me, params, body }) => team.updateChannel(me, params[0]!, body)),
    r("POST", `/channels/${ID}/archive`, ({ team, me, params, body }) => team.archiveChannel(me, params[0]!, body.archived !== false)),
    r("POST", `/channels/${ID}/join`, ({ team, me, params }) => team.joinChannel(me, params[0]!)),
    r("POST", `/channels/${ID}/leave`, ({ team, me, params }) => team.leaveChannel(me, params[0]!)),
    r("POST", `/channels/${ID}/invite`, ({ team, me, params, body }) => team.invite(me, params[0]!, body.people)),
    r("POST", `/channels/${ID}/kick`, ({ team, me, params, body }) => team.kick(me, params[0]!, str(body.username))),
    r("PUT", `/channels/${ID}/prefs`, ({ team, me, params, body }) => team.setChannelPrefs(me, params[0]!, body)),
    r("GET", `/workspaces/${ID}/sections`, ({ team, me, params }) => ({ sections: team.sections(me, params[0]!) })),
    r("POST", `/workspaces/${ID}/sections`, ({ team, me, params, body }) => team.createSection(me, params[0]!, body), { status: 201 }),
    r("PATCH", `/sections/${ID}`, ({ team, me, params, body }) => ({ sections: team.updateSection(me, params[0]!, body) })),
    r("DELETE", `/sections/${ID}`, ({ team, me, params }) => team.deleteSection(me, params[0]!)),
    r("GET", `/workspaces/${ID}/keywords`, ({ team, me, params }) => ({ keywords: team.keywords(me, params[0]!) })),
    r("PUT", `/workspaces/${ID}/keywords`, ({ team, me, params, body }) => ({ keywords: team.setKeywords(me, params[0]!, body.keywords) })),
    r("POST", `/channels/${ID}/read`, ({ team, me, params, body }) => team.markRead(me, params[0]!, typeof body.unreadFrom === "string" ? body.unreadFrom : undefined)),
    r("GET", `/channels/${ID}/people`, ({ team, me, params }) => ({ people: team.channelPeople(me, params[0]!) })),
    r("GET", `/channels/${ID}/messages`, ({ team, me, params, query }) => team.list(me, params[0]!, {
      before: query.get("before") ?? undefined, after: query.get("after") ?? undefined, around: query.get("around") ?? undefined,
      limit: query.has("limit") ? Number(query.get("limit")) || undefined : undefined,
    })),
    r("POST", `/channels/${ID}/messages`, ({ team, me, params, body }) => team.send(me, params[0]!, {
      text: typeof body.text === "string" ? body.text : "",
      parentId: typeof body.parentId === "string" ? body.parentId : null,
      alsoInChannel: body.alsoInChannel === true,
      fileIds: Array.isArray(body.fileIds) ? body.fileIds.filter((f): f is string => typeof f === "string").slice(0, 10) : [],
      tzOffset: typeof body.tzOffset === "number" && Math.abs(body.tzOffset) <= 14 * 60 ? body.tzOffset : 0,
    }), { status: 201 }),
    r("GET", `/channels/${ID}/pins`, ({ team, me, params }) => ({ team, messages: team.pins(me, params[0]!) })),
    r("GET", `/channels/${ID}/canvas`, ({ team, me, params }) => team.canvas(me, params[0]!)),
    r("PUT", `/channels/${ID}/canvas`, ({ team, me, params, body }) => team.setCanvas(me, params[0]!, body.text)),
    r("GET", `/channels/${ID}/tasks`, ({ team, me, params }) => ({ tasks: team.tasks(me, params[0]!) })),
    r("POST", `/channels/${ID}/tasks`, ({ team, me, params, body }) => team.createTask(me, params[0]!, body), { status: 201 }),
    r("PATCH", `/tasks/${ID}`, ({ team, me, params, body }) => team.updateTask(me, params[0]!, body)),
    r("DELETE", `/tasks/${ID}`, ({ team, me, params }) => team.deleteTask(me, params[0]!)),
    r("GET", `/workspaces/${ID}/tasks`, ({ team, me, params }) => ({ tasks: team.myTasks(me, params[0]!) })),
    r("POST", `/channels/${ID}/bookmarks`, ({ team, me, params, body }) => team.addBookmark(me, params[0]!, body), { status: 201 }),
    r("POST", `/channels/${ID}/files`, ({ team, me, params, body }) => team.upload(me, params[0]!, body), { status: 201, limit: FILE_BODY_LIMIT }),
    r("GET", `/channels/${ID}/workflows`, ({ team, me, params }) => ({ workflows: team.workflows(me, params[0]!) })),
    r("POST", `/channels/${ID}/workflows`, ({ team, me, params, body }) => team.createWorkflow(me, params[0]!, body), { status: 201 }),
    r("POST", `/channels/${ID}/webhooks`, ({ team, me, params, body }) => team.createWebhook(me, params[0]!, body), { status: 201 }),
    r("GET", `/channels/${ID}/huddle`, ({ team, me, params }) => ({ huddle: team.huddle(me, params[0]!) })),
    r("POST", `/channels/${ID}/huddle/join`, ({ team, me, params }) => team.joinHuddle(me, params[0]!)),
    r("POST", `/channels/${ID}/huddle/leave`, ({ team, me, params }) => team.leaveHuddle(me, params[0]!)),
    r("PUT", `/channels/${ID}/huddle`, ({ team, me, params, body }) => team.updateHuddle(me, params[0]!, body)),
    r("POST", `/channels/${ID}/huddle/signal`, ({ team, me, params, body }) => team.signalHuddle(me, params[0]!, body), { bucket: { name: "signal", max: 1200 } }),
    r("POST", `/channels/${ID}/polls`, ({ team, me, params, body }) => team.createPoll(me, params[0]!, body), { status: 201 }),
    r("POST", `/channels/${ID}/schedule`, ({ team, me, params, body }) => team.schedule(me, params[0]!, body), { status: 201 }),
    r("POST", `/channels/${ID}/typing`, ({ team, me, params, body }) => team.typing(me, params[0]!, typeof body.parentId === "string" ? body.parentId : null)),

    r("GET", `/messages/${ID}`, ({ team, me, params }) => team.getMessage(me, params[0]!)),
    r("GET", `/messages/${ID}/thread`, ({ team, me, params }) => team.thread(me, params[0]!)),
    r("PATCH", `/messages/${ID}`, ({ team, me, params, body }) => team.edit(me, params[0]!, body.text)),
    r("DELETE", `/messages/${ID}`, ({ team, me, params }) => team.remove(me, params[0]!)),
    r("POST", `/messages/${ID}/reactions`, ({ team, me, params, body }) => ({ reactions: team.react(me, params[0]!, body.emoji, typeof body.on === "boolean" ? body.on : undefined) })),
    r("PUT", `/messages/${ID}/pin`, ({ team, me, params, body }) => team.pin(me, params[0]!, body.pinned !== false)),
    r("PUT", `/messages/${ID}/save`, ({ team, me, params, body }) => team.save(me, params[0]!, body)),
    r("POST", `/messages/${ID}/vote`, ({ team, me, params, body }) => team.vote(me, params[0]!, body.choice, typeof body.on === "boolean" ? body.on : undefined)),
    r("POST", `/messages/${ID}/close`, ({ team, me, params }) => team.closePoll(me, params[0]!)),
    r("POST", `/messages/${ID}/share`, ({ team, me, params, body }) => team.share(me, params[0]!, body)),

    r("DELETE", `/bookmarks/${ID}`, ({ team, me, params }) => team.removeBookmark(me, params[0]!)),
    r("GET", `/files/${ID}`, ({ team, me, params, query, res, security }) => {
      const file = team.download(me, params[0]!);
      const inline = query.get("inline") === "1" && INLINE_TYPES.has(file.mime);
      res.writeHead(200, {
        ...security,
        "content-type": inline ? file.mime : "application/octet-stream",
        "content-length": file.data.length,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(file.data);
    }, { raw: true }),
    r("PATCH", `/workflows/${ID}`, ({ team, me, params, body }) => team.updateWorkflow(me, params[0]!, body)),
    r("DELETE", `/workflows/${ID}`, ({ team, me, params }) => team.deleteWorkflow(me, params[0]!)),
    r("GET", `/workspaces/${ID}/emoji`, ({ team, me, params }) => ({ emoji: team.emojis(me, params[0]!) })),
    r("POST", `/workspaces/${ID}/emoji`, ({ team, me, params, body }) => team.addEmoji(me, params[0]!, body), { status: 201, limit: EMOJI_BODY_LIMIT }),
    r("DELETE", `/workspaces/${ID}/emoji/${EMOJI}`, ({ team, me, params }) => team.removeEmoji(me, params[0]!, params[1]!)),
    r("GET", `/workspaces/${ID}/emoji/${EMOJI}`, ({ team, me, params, res, security }) => {
      const image = team.emojiImage(me, params[0]!, params[1]!);
      res.writeHead(200, {
        ...security,
        "content-type": image.mime,
        "content-length": image.data.length,
        "cache-control": "private, max-age=300",
        "content-security-policy": "default-src 'none'; sandbox",
      });
      res.end(image.data);
    }, { raw: true }),
    r("DELETE", `/webhooks/${ID}`, ({ team, me, params }) => team.deleteWebhook(me, params[0]!)),
    r("DELETE", `/scheduled/${ID}`, ({ team, me, params }) => team.cancelScheduled(me, params[0]!)),
    r("PATCH", `/reminders/${ID}`, ({ team, me, params, body }) => team.updateReminder(me, params[0]!, body)),
    r("DELETE", `/reminders/${ID}`, ({ team, me, params }) => team.deleteReminder(me, params[0]!)),
  ];
}

const ROUTES = teamRoutes();

/** Handle an /api/team request. Returns false when the path is not a team route. */
export async function handleTeam(req: IncomingMessage, res: ServerResponse, url: URL, context: TeamHttpContext): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/team/")) return false;
  const method = req.method ?? "GET";

  if (path === "/api/team/events" && method === "GET") {
    const actor = await context.authenticate(req);
    context.hub.attach(actor.identity.sub, req, res, context.security);
    return true;
  }

  // Incoming webhooks: called by other servers, so no session and no Origin check. The token is the credential.
  const hook = /^\/api\/team\/hooks\/([0-9a-fA-F-]{36})\/([A-Za-z0-9_-]{43})$/.exec(path);
  if (hook) {
    if (method !== "POST") throw new FabricServiceError(405, "method not allowed");
    if (!context.allow(`hook:${hook[1]!.toLowerCase()}`, 60, 60_000)) throw new FabricServiceError(429, "too many requests");
    const parsed = await context.readJson(req, BODY_LIMIT);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FabricServiceError(400, "bad request");
    const body = parsed as Record<string, unknown>;
    context.sendJson(res, 200, context.team.postWebhook(hook[1]!, hook[2]!, { text: body.text, threadId: body.threadId ?? body.thread_id }));
    return true;
  }

  let matchedPath = false;
  for (const route of ROUTES) {
    const m = route.pattern.exec(path);
    if (!m) continue;
    matchedPath = true;
    if (route.method !== method) continue;
    const actor = await context.authenticate(req);
    const me = actor.identity;
    context.team.seen(me.sub);
    let body: Record<string, unknown> = {};
    if (method !== "GET") {
      context.assertMutation(req, actor);
      const isFile = route.limit !== undefined;
      const bucket = route.bucket ?? (isFile ? { name: "file", max: 30 } : { name: "team", max: 300 });
      if (!context.allow(`${bucket.name}:${me.sub}`, bucket.max, 60_000)) throw new FabricServiceError(429, "too many requests");
      if (method !== "DELETE" || req.headers["content-type"]) {
        const parsed = req.headers["content-length"] === "0" && method === "DELETE" ? {} : await context.readJson(req, route.limit ?? BODY_LIMIT);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FabricServiceError(400, "bad request");
        body = parsed as Record<string, unknown>;
      }
    }
    const out = await route.handler({ team: context.team, security: context.security, me, params: m.slice(1).map((p) => p.toLowerCase()), query: url.searchParams, body, req, res });
    if (route.raw) return true;
    if (out === undefined) {
      res.writeHead(204, context.security);
      res.end();
    } else {
      context.sendJson(res, route.status ?? 200, out);
    }
    return true;
  }
  if (matchedPath) throw new FabricServiceError(405, "method not allowed");
  context.sendJson(res, 404, { error: "not found" });
  return true;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
