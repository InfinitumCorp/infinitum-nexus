import { CidLabyrinth, LabyrinthError } from "@infinitum/lbrnth";
import { decodeTelemetry } from "./mavlink.ts";

/** Administrative inventory/archival only. No control, planning, navigation or targeting. */
export const DRONE_PRODUCTS = Object.freeze({
  daemon: {name: "DAEMON", domain: "air"},
  slug: {name: "SLUG", domain: "land"},
  orbis: {name: "ORBIS", domain: "air"},
  pollen: {name: "POLLEN", domain: "air"},
  flower: {name: "Flower", domain: "base"},
} as const);
type Product = keyof typeof DRONE_PRODUCTS;
type ObjectValue = Record<string, unknown>;
const invalid = (message: string): never => { throw new LabyrinthError("invalid", message); };
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected an object");
  return value as ObjectValue;
}
function exact(value: ObjectValue, fields: string[]) {
  if (Object.keys(value).some(key => !fields.includes(key))) invalid("Unknown field");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) return invalid("Invalid identifier");
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) return invalid("Invalid commit hash");
  return value;
}
function sourceId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 255) return invalid("Invalid MAVLink source id");
  return value;
}
function base64(value: unknown) {
  if (typeof value !== "string" || value.length > 43692 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid("Invalid base64 telemetry");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) return invalid("Noncanonical base64 telemetry");
  return bytes;
}
class HttpError extends Error {
  status: number;
  constructor(status: number) {super("Request refused"); this.status = status;}
}
async function readBody(request: Request): Promise<ObjectValue> {
  const limit = 131072;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413);
  if (!request.body) invalid("JSON body required");
  const reader = request.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const result = await reader.read(); if (result.done) break;
      length += result.value.length;
      if (length > limit) { await reader.cancel(); throw new HttpError(413); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return object(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks))));
}
const headers = {"content-type":"application/json", "cache-control":"no-store", "x-content-type-options":"nosniff"};
/** Mount behind a TLS host with rate/connection/deadline limits. No network listener is opened. */
export function droneBackend(auth: CidLabyrinth) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const match = /^\/api\/drones\/(daemon|slug|orbis|pollen|flower)$/.exec(url.pathname);
      if (!match || url.search) throw new HttpError(404);
      if (request.method !== "POST") return Response.json({error:"method_not_allowed"}, {status:405, headers:{...headers, allow:"POST"}});
      if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) throw new HttpError(403);
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || request.headers.has("content-encoding")) throw new HttpError(415);
      const bearer = /^Bearer ([^\s]{1,512})$/.exec(request.headers.get("authorization") ?? "");
      if (!bearer) throw new HttpError(401);
      const product = match[1] as Product;
      const client = auth.forProduct(bearer[1]!, product);
      client.repositories(); // live session, directory, role, read consent AND independent paid-plan authority
      const body = await readBody(request);
      const repo = identifier(body.repo);
      const prefix = `products/${product}/`;
      const head = () => body.expectedHead === null ? null : hash(body.expectedHead);
      const now = () => new Date().toISOString();
      let result: unknown;
      if (body.action === "fleet") {
        exact(body, ["action", "repo"]);
        const latest = client.history(repo, "main", 1)[0];
        const ids = latest ? Object.keys(latest.tree).filter(path => path.startsWith(`${prefix}fleet/`) && path.endsWith(".json")) : [];
        if (ids.length > 64) throw new LabyrinthError("capacity", "Fleet listing limit exceeded");
        result = {head: latest?.id ?? null, vehicles: ids.map(path => JSON.parse(Buffer.from(client.load(repo, latest!.id, path.slice(prefix.length))).toString("utf8")))};
      } else if (body.action === "register") {
        exact(body, ["action", "repo", "expectedHead", "vehicle", "systemId", "componentId"]);
        const vehicle = identifier(body.vehicle);
        const latest = client.history(repo, "main", 1)[0];
        const paths = latest ? Object.keys(latest.tree).filter(path => path.startsWith(`${prefix}fleet/`)) : [];
        if (paths.length >= 64 && !paths.includes(`${prefix}fleet/${vehicle}.json`)) throw new LabyrinthError("capacity", "Fleet registration limit exceeded");
        const registration = {schema:1, product, domain:DRONE_PRODUCTS[product].domain, vehicle, systemId:sourceId(body.systemId), componentId:sourceId(body.componentId), registeredAt:now()};
        result = client.save(repo, `fleet/${vehicle}.json`, JSON.stringify(registration), head(), "Register fleet inventory record");
      } else if (body.action === "telemetry") {
        exact(body, ["action", "repo", "expectedHead", "vehicle", "registrationCommit", "log", "frames"]);
        const vehicle = identifier(body.vehicle), log = identifier(body.log);
        const registrationCommit = hash(body.registrationCommit);
        const registration = object(JSON.parse(Buffer.from(client.load(repo, registrationCommit, `fleet/${vehicle}.json`)).toString("utf8")));
        if (registration.product !== product || registration.vehicle !== vehicle) invalid("Registration mismatch");
        let observations;
        try { observations = decodeTelemetry(base64(body.frames)); }
        catch { return invalid("Invalid or unsupported MAVLink telemetry"); }
        if (observations.some(frame => frame.systemId !== registration.systemId || frame.componentId !== registration.componentId)) invalid("Telemetry source differs from registration");
        const artifact = {schema:1, product, vehicle, registrationCommit, receivedAt:now(), source:"authenticated-upload", senderVerified:false, controlAuthority:false, observations};
        result = client.save(repo, `logs/${vehicle}/${log}.json`, JSON.stringify(artifact), head(), "Archive selected telemetry observations");
      } else if (body.action === "load") {
        exact(body, ["action", "repo", "commit", "kind", "vehicle", "artifact"]);
        const vehicle = identifier(body.vehicle), commit = hash(body.commit);
        if (body.kind !== "fleet" && body.kind !== "logs") invalid("Unknown artifact kind");
        const path = body.kind === "fleet" ? `fleet/${vehicle}.json` : `logs/${vehicle}/${identifier(body.artifact)}.json`;
        result = JSON.parse(Buffer.from(client.load(repo, commit, path)).toString("utf8"));
      } else if (body.action === "lineage") {
        exact(body, ["action", "repo"]);
        const history = client.history(repo, "main", 100);
        // Return only commits that changed this product's files; never leak sibling product paths.
        const commits = history.flatMap((commit, index) => {
          const parent = history[index + 1];
          // A parent outside this bounded window cannot be compared reliably.
          if (commit.parent && parent?.id !== commit.parent) return [];
          const tree = parent?.tree ?? {};
          const paths = [...new Set([...Object.keys(commit.tree), ...Object.keys(tree)])].filter(path => path.startsWith(prefix) && tree[path] !== commit.tree[path]);
          return paths.length ? [{id:commit.id, parent:commit.parent, author:commit.author, at:commit.at, paths}] : [];
        });
        result = {commits, windowLimit:100, anchoring:"local-hash-chain-only"};
      } else invalid("Unknown action");
      return Response.json(result, {headers});
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof LabyrinthError ? ({forbidden:403, not_found:404, invalid:400, conflict:409, capacity:413, integrity:500} as const)[error.code] : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500;
      return Response.json({error: status === 500 ? "internal_error" : "request_denied"}, {status, headers});
    }
  };
}
