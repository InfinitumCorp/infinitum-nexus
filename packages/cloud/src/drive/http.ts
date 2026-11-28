import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CUMULUS_CLOUD_ORIGIN, CUMULUS_ORIGINS } from "@infinitum/cid";
import type { DriveAuth, DrivePrincipal } from "./auth.ts";
import { cleanId, cleanName, cleanSha256, declaredType, optionalId } from "./names.ts";
import { RateLimiter } from "./rate-limit.ts";
import { DriveError } from "./errors.ts";
import type { DriveService } from "./service.ts";

type AuthMode = "none" | "session" | "read" | "write";

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  principal: DrivePrincipal | null;
}

type Handler = (ctx: Ctx) => Promise<void>;

const OWNER_FIELDS = ["owner", "ownerCid", "owner_cid", "cid", "accountId", "account_id"];

/**
 * HTTP API for Cumulus://Cloud Drive.
 * Public routes are health and share links. Everything else requires a
 * Cumulus://ID bearer token, and the CID on that session owns the files.
 */
export function createDriveApp(opts: {
  service: DriveService;
  auth: DriveAuth;
  rateLimit?: number;
  rateWindowMs?: number;
  /** Absolute origin used in share links. Default https://cloud.cumuluscloud.app. */
  publicOrigin?: string;
  /** Browser origins allowed to call this API. Default ID, Cloud, and Mail. */
  allowedOrigins?: readonly string[];
}): { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>; server: () => Server } {
  const service = opts.service;
  const auth = opts.auth;
  const limiter = new RateLimiter(opts.rateLimit ?? 120, opts.rateWindowMs ?? 60_000);
  const publicOrigin = (opts.publicOrigin ?? CUMULUS_CLOUD_ORIGIN).replace(/\/$/, "");
  const allowedOrigins = new Set(opts.allowedOrigins ?? CUMULUS_ORIGINS);
  const routes: { method: string; re: RegExp; keys: string[]; auth: AuthMode; handler: Handler }[] = [];

  const route = (method: string, path: string, mode: AuthMode, handler: Handler) => {
    const keys: string[] = [];
    const pattern = path.replace(/:([A-Za-z]+)/g, (_match, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    routes.push({ method, re: new RegExp(`^${pattern}$`), keys, auth: mode, handler });
  };

  route("GET", "/v1/health", "none", async ({ res }) => {
    await service.repo.ping();
    send(res, 200, { ok: true, service: "cumulus-cloud", driver: service.driverKind });
  });

  route("POST", "/v1/access", "session", async ({ res, principal }) => {
    if (!principal) return;
    await auth.grantDrive(principal.cid);
    send(res, 200, { cid: principal.cid, scopes: ["drive:read", "drive:write"] });
  });

  route("GET", "/v1/quota", "read", async ({ res, principal }) => {
    if (!principal) return;
    send(res, 200, await service.quota(principal.cid));
  });

  route("GET", "/v1/list", "read", async ({ res, query, principal }) => {
    if (!principal) return;
    const folderId = query.get("folderId");
    send(res, 200, await service.list(principal.cid, folderId ? cleanId(folderId, "Folder") : null, {
      cursorFolder: cursorOf(query.get("folderCursor")),
      cursorFile: cursorOf(query.get("fileCursor")),
      limit: limitOf(query.get("limit")),
    }));
  });

  route("GET", "/v1/trash", "read", async ({ res, principal }) => {
    if (!principal) return;
    send(res, 200, await service.trash(principal.cid));
  });

  route("POST", "/v1/trash/empty", "write", async ({ res, principal }) => {
    if (!principal) return;
    send(res, 200, await service.emptyTrash(principal.cid));
  });

  route("POST", "/v1/folders", "write", async ({ req, res, principal }) => {
    if (!principal) return;
    const body = await readJson(req);
    rejectForeignOwner(body, principal.cid);
    const name = cleanName(stringField(body.name, "Name"));
    const folder = await service.createFolder(principal.cid, name, optionalId(body.parentId, "Folder"));
    send(res, 201, { folder });
  });

  route("PATCH", "/v1/folders/:id", "write", async ({ req, res, params, principal }) => {
    if (!principal) return;
    const body = await readJson(req);
    rejectForeignOwner(body, principal.cid);
    const patch: { name?: string; parentId?: string | null } = {};
    if ("name" in body) patch.name = cleanName(stringField(body.name, "Name"));
    if ("parentId" in body) patch.parentId = optionalId(body.parentId, "Folder");
    send(res, 200, { folder: await service.updateFolder(principal.cid, cleanId(params.id ?? "", "Folder"), patch) });
  });

  route("DELETE", "/v1/folders/:id", "write", async ({ res, params, query, principal }) => {
    if (!principal) return;
    const id = cleanId(params.id ?? "", "Folder");
    if (purge(query)) await service.purgeFolder(principal.cid, id);
    else await service.trashFolder(principal.cid, id);
    send(res, 200, { ok: true });
  });

  route("POST", "/v1/folders/:id/restore", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { folder: await service.restoreFolder(principal.cid, cleanId(params.id ?? "", "Folder")) });
  });

  route("POST", "/v1/files", "write", async ({ req, res, principal }) => {
    if (!principal) return;
    const file = await service.upload(principal.cid, req, uploadMeta(req));
    send(res, 201, { file });
  });

  route("POST", "/v1/files/:id/content", "write", async ({ req, res, params, principal }) => {
    if (!principal) return;
    const meta = uploadMeta(req);
    const file = await service.uploadVersion(principal.cid, cleanId(params.id ?? "", "File"), req, {
      declaredSize: meta.declaredSize,
      declaredType: meta.declaredType,
      expectedSha256: meta.expectedSha256,
    });
    send(res, 201, { file });
  });

  route("GET", "/v1/files/:id", "read", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { file: await service.getFile(principal.cid, cleanId(params.id ?? "", "File")) });
  });

  route("GET", "/v1/files/:id/content", "read", async ({ req, res, params, principal }) => {
    if (!principal) return;
    await sendDownload(res, await service.download(principal.cid, cleanId(params.id ?? "", "File"), rangeOf(req)));
  });

  route("POST", "/v1/files/:id/verify", "read", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, await service.verifyFile(principal.cid, cleanId(params.id ?? "", "File")));
  });

  route("PATCH", "/v1/files/:id", "write", async ({ req, res, params, principal }) => {
    if (!principal) return;
    const body = await readJson(req);
    rejectForeignOwner(body, principal.cid);
    const patch: { name?: string; folderId?: string | null } = {};
    if ("name" in body) patch.name = cleanName(stringField(body.name, "Name"));
    if ("folderId" in body) patch.folderId = optionalId(body.folderId, "Folder");
    send(res, 200, { file: await service.updateFile(principal.cid, cleanId(params.id ?? "", "File"), patch) });
  });

  route("DELETE", "/v1/files/:id", "write", async ({ res, params, query, principal }) => {
    if (!principal) return;
    const id = cleanId(params.id ?? "", "File");
    if (purge(query)) await service.purgeFile(principal.cid, id);
    else await service.trashFile(principal.cid, id);
    send(res, 200, { ok: true });
  });

  route("POST", "/v1/files/:id/restore", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { file: await service.restoreFile(principal.cid, cleanId(params.id ?? "", "File")) });
  });

  route("GET", "/v1/files/:id/versions", "read", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { versions: await service.versions(principal.cid, cleanId(params.id ?? "", "File")) });
  });

  route("DELETE", "/v1/files/:id/versions/:versionId", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    await service.deleteVersion(principal.cid, cleanId(params.id ?? "", "File"), cleanId(params.versionId ?? "", "Version"));
    send(res, 200, { ok: true });
  });

  route("POST", "/v1/uploads", "write", async ({ req, res, principal }) => {
    if (!principal) return;
    const body = await readJson(req);
    rejectForeignOwner(body, principal.cid);
    const size = numberField(body.size, "Size");
    const upload = await service.startUpload(principal.cid, {
      name: cleanName(stringField(body.name, "Name")),
      folderId: optionalId(body.folderId, "Folder"),
      fileId: body.fileId === undefined || body.fileId === null ? null : cleanId(String(body.fileId), "File"),
      declaredSize: size,
      declaredType: declaredType(body.contentType),
      expectedSha256: cleanSha256(body.sha256),
    });
    send(res, 201, { upload });
  });

  route("GET", "/v1/uploads/:id", "read", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { upload: await service.uploadStatus(principal.cid, cleanId(params.id ?? "", "Upload")) });
  });

  route("PUT", "/v1/uploads/:id/parts/:part", "write", async ({ req, res, params, principal }) => {
    if (!principal) return;
    const part = Number(params.part);
    if (!/^\d+$/.test(params.part ?? "")) throw new DriveError(400, "bad_part", "Part numbers run from 1 to 10000");
    const saved = await service.putPart(principal.cid, cleanId(params.id ?? "", "Upload"), part, req, contentLength(req));
    send(res, 200, { part: saved });
  });

  route("POST", "/v1/uploads/:id/complete", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 201, { file: await service.completeUpload(principal.cid, cleanId(params.id ?? "", "Upload")) });
  });

  route("DELETE", "/v1/uploads/:id", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    await service.abortUpload(principal.cid, cleanId(params.id ?? "", "Upload"));
    send(res, 200, { ok: true });
  });

  route("POST", "/v1/files/:id/shares", "write", async ({ req, res, params, principal }) => {
    if (!principal) return;
    const body = await readJson(req);
    rejectForeignOwner(body, principal.cid);
    const share = await service.createShare(principal.cid, cleanId(params.id ?? "", "File"), body.expiresAt);
    send(res, 201, { share: { ...share, url: share.token ? `${publicOrigin}/v1/s/${share.token}` : undefined } });
  });

  route("GET", "/v1/files/:id/shares", "read", async ({ res, params, principal }) => {
    if (!principal) return;
    send(res, 200, { shares: await service.listShares(principal.cid, cleanId(params.id ?? "", "File")) });
  });

  route("DELETE", "/v1/shares/:id", "write", async ({ res, params, principal }) => {
    if (!principal) return;
    await service.revokeShare(principal.cid, cleanId(params.id ?? "", "Share"));
    send(res, 200, { ok: true });
  });

  route("GET", "/v1/s/:token", "none", async ({ res, params }) => {
    send(res, 200, { file: await service.shareInfo(params.token ?? "") });
  });

  route("GET", "/v1/s/:token/content", "none", async ({ req, res, params }) => {
    await sendDownload(res, await service.openShare(params.token ?? "", rangeOf(req)));
  });

  function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !allowedOrigins.has(origin)) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range, X-Cumulus-Name, X-Cumulus-Folder, X-Cumulus-Sha256");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Disposition, Content-Range, ETag");
    return true;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const cors = applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(!req.headers.origin || cors ? 204 : 403);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const ipHit = limiter.allow(`ip:${req.socket.remoteAddress ?? "unknown"}`);
    if (!ipHit.ok) {
      res.setHeader("Retry-After", String(ipHit.retryAfterSec));
      send(res, 429, { error: { code: "rate_limited", message: "Too many requests" } });
      return;
    }
    try {
      const match = routes.find((candidate) => candidate.method === req.method && candidate.re.test(url.pathname));
      if (!match) {
        send(res, 404, { error: { code: "not_found", message: "No such route" } });
        return;
      }
      const groups = match.re.exec(url.pathname);
      const params: Record<string, string> = {};
      match.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(groups?.[index + 1] ?? "");
      });
      const principal = await authenticate(req, auth);
      if (match.auth !== "none") {
        if (!principal) throw new DriveError(401, "unauthorized", "Sign in with Cumulus://ID");
        const who = limiter.allow(`cid:${principal.cid}`);
        if (!who.ok) {
          res.setHeader("Retry-After", String(who.retryAfterSec));
          throw new DriveError(429, "rate_limited", "Too many requests");
        }
        if (match.auth === "read" && !(await auth.can(principal.cid, "drive:read"))) {
          throw new DriveError(403, "forbidden", "Cumulus://Cloud read access was revoked");
        }
        if (match.auth === "write" && !(await auth.can(principal.cid, "drive:write"))) {
          throw new DriveError(403, "forbidden", "Cumulus://Cloud write access was revoked");
        }
      }
      await match.handler({ req, res, params, query: url.searchParams, principal });
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.destroy();
      if (!req.readableEnded) req.resume();
    }
  }

  return {
    handle,
    server: () => createServer((req, res) => void handle(req, res)),
  };
}

async function authenticate(req: IncomingMessage, auth: DriveAuth): Promise<DrivePrincipal | null> {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match?.[1]) return null;
  return auth.authenticate(match[1]);
}

function uploadMeta(req: IncomingMessage) {
  const folder = req.headers["x-cumulus-folder"];
  const checksum = req.headers["x-cumulus-sha256"];
  return {
    name: headerName(req),
    folderId: typeof folder === "string" && folder ? cleanId(folder, "Folder") : null,
    declaredSize: contentLength(req),
    declaredType: declaredType(typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined),
    expectedSha256: cleanSha256(typeof checksum === "string" ? checksum : null),
  };
}

function headerName(req: IncomingMessage): string {
  const raw = req.headers["x-cumulus-name"];
  if (!raw || Array.isArray(raw)) throw new DriveError(400, "name_required", "Set X-Cumulus-Name");
  let name = raw;
  if (raw.includes("%")) {
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
  }
  return cleanName(name);
}

function contentLength(req: IncomingMessage): number {
  const raw = req.headers["content-length"];
  if (raw === undefined || Array.isArray(raw) || !/^\d+$/.test(raw)) {
    throw new DriveError(411, "length_required", "Content-Length is required");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new DriveError(400, "bad_size", "Content-Length is not valid");
  return value;
}

function rangeOf(req: IncomingMessage): { start: number; end: number } | null {
  const raw = req.headers.range;
  if (!raw) return null;
  if (Array.isArray(raw) || raw.includes(",")) throw new DriveError(416, "bad_range", "Range is not satisfiable");
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
  if (!match) throw new DriveError(416, "bad_range", "Range is not satisfiable");
  if (match[1] === "" && match[2]) return { start: -Number(match[2]), end: -1 };
  if (match[1] === "") throw new DriveError(416, "bad_range", "Range is not satisfiable");
  const start = Number(match[1]);
  const end = match[2] === "" ? Number.MAX_SAFE_INTEGER : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new DriveError(416, "bad_range", "Range is not satisfiable");
  return { start, end };
}

async function sendDownload(res: ServerResponse, download: Awaited<ReturnType<DriveService["download"]>>) {
  const partial = download.total > 0 && (download.start !== 0 || download.end !== download.total - 1);
  const length = download.total === 0 ? 0 : download.end - download.start + 1;
  const inline = download.info.mediaType.startsWith("image/") || download.info.mediaType === "application/pdf";
  res.writeHead(partial ? 206 : 200, {
    "Content-Type": download.info.mediaType,
    "Content-Length": String(length),
    "Content-Disposition": disposition(download.info.name, inline),
    "Accept-Ranges": "bytes",
    ETag: `"${download.info.sha256}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    "X-Frame-Options": "DENY",
    ...(partial ? { "Content-Range": `bytes ${download.start}-${download.end}/${download.total}` } : {}),
  });
  download.stream.on("error", () => res.destroy());
  res.on("close", () => download.stream.destroy());
  download.stream.pipe(res);
}

function disposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 65_536) throw new DriveError(413, "too_large", "JSON body is too large");
    chunks.push(buf);
  }
  if (size === 0) throw new DriveError(400, "bad_json", "Body must be a JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DriveError(400, "bad_json", "Body must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DriveError(400, "bad_json", "Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function rejectForeignOwner(body: Record<string, unknown>, ownerCid: string) {
  for (const field of OWNER_FIELDS) {
    if (!(field in body) || body[field] === undefined) continue;
    if (String(body[field]) !== ownerCid) throw new DriveError(400, "owner_mismatch", "Ownership comes from the Cumulus://ID session");
  }
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new DriveError(400, "bad_name", `${label} is required`);
  return value;
}

function numberField(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DriveError(400, "bad_size", `${label} is not a valid byte count`);
  }
  return value;
}

function limitOf(raw: string | null): number | undefined {
  if (raw === null || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new DriveError(400, "bad_limit", "Limit must be from 1 to 500");
  return Number(raw);
}

function cursorOf(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.length > 255) throw new DriveError(400, "bad_cursor", "Cursor is too long");
  return raw;
}

function purge(query: URLSearchParams): boolean {
  const value = query.get("purge");
  return value === "1" || value === "true";
}

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown) {
  if (err instanceof DriveError) {
    if (err.status === 416) res.setHeader("Content-Range", "bytes */*");
    send(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error("Cumulus://Cloud request failed");
  send(res, 500, { error: { code: "internal", message: "Something went wrong" } });
}
