import { CidLabyrinth, LabyrinthError } from "@infinitum/lbrnth";
import { parseTle, parseOmm, restoreOrbit, propagateAt } from "./orbit.ts";
import { predictPasses, scheduleContacts, linkBudget } from "./planning.ts";
import { catalogItem, artifactPath, hash } from "./catalog.ts";
import { ValidationError, record, exact, id, invalid } from "./validation.ts";
export type OrbitalProduct = "firmament" | "orbis";
class HttpError extends Error {
  status: number;
  constructor(status: number) {
    super("Request refused");
    this.status = status;
  }
}
const headers = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
async function readBody(request: Request) {
  const limit = 65536,
    declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new HttpError(413);
  if (!request.body) invalid("JSON body required");
  const reader = request.body!.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new HttpError(413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
}
/** No listener or hardware connection. Host must enforce TLS, rates and connection deadlines. */
export function orbitalBackend(auth: CidLabyrinth) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        match = /^\/api\/orbital\/(firmament|orbis)$/.exec(url.pathname);
      if (!match || url.search) throw new HttpError(404);
      if (request.method !== "POST")
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { ...headers, allow: "POST" } },
        );
      if (
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      )
        throw new HttpError(403);
      if (
        request.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json" ||
        request.headers.has("content-encoding")
      )
        throw new HttpError(415);
      const bearer = /^Bearer ([^\s]{1,512})$/.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!bearer) throw new HttpError(401);
      const product = match[1] as OrbitalProduct,
        client = auth.forProduct(bearer[1]!, product);
      client.repositories();
      const body = await readBody(request),
        repo = id(body.repo);
      if (body.action === "load") {
        exact(body, ["action", "repo", "commit", "path"]);
        const path = artifactPath(body.path);
        if (
          !/^orbital\/(elements|states|passes|schedules|budgets|catalog)\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(
            path,
          )
        )
          invalid("Orbital artifact path required");
        const bytes = client.load(repo, hash(body.commit), path);
        return Response.json(JSON.parse(Buffer.from(bytes).toString("utf8")), {
          headers,
        });
      }
      const identifier = id(body.id),
        expectedHead =
          body.expectedHead === null ? null : hash(body.expectedHead);
      // Cheap authorization/CAS preflight before bounded numerical work; save rechecks atomically.
      const latest = client.history(repo, "main", 1)[0];
      if ((latest?.id ?? null) !== expectedHead)
        throw new LabyrinthError("conflict", "Expected head differs");
      let kind: string, data: unknown, source: unknown;
      const common = ["action", "repo", "id", "expectedHead"];
      const loadOrbit = () => {
        const ref = record(body.source);
        exact(ref, ["id", "commit"]);
        const commit = hash(ref.commit),
          orbitId = id(ref.id);
        const stored = record(
          JSON.parse(
            Buffer.from(
              client.load(repo, commit, `orbital/elements/${orbitId}.json`),
            ).toString("utf8"),
          ),
        );
        if (stored.product !== product || stored.kind !== "elements")
          invalid("Orbital source mismatch");
        source = { id: orbitId, commit };
        return restoreOrbit(stored.data);
      };
      switch (body.action) {
        case "tle":
          exact(body, [...common, "line1", "line2"]);
          kind = "elements";
          data = parseTle(body.line1, body.line2);
          break;
        case "omm":
          exact(body, [...common, "elements"]);
          kind = "elements";
          data = parseOmm(body.elements);
          break;
        case "propagate":
          exact(body, [...common, "source", "at"]);
          kind = "states";
          if (typeof body.at !== "string") invalid("UTC time required");
          data = propagateAt(loadOrbit(), body.at as string);
          break;
        case "passes":
          exact(body, [...common, "source", "options"]);
          kind = "passes";
          data = predictPasses(loadOrbit(), body.options);
          break;
        case "schedule":
          exact(body, [...common, "requests", "options"]);
          kind = "schedules";
          data = scheduleContacts(body.requests, body.options ?? {});
          break;
        case "link-budget":
          exact(body, [...common, "parameters"]);
          kind = "budgets";
          data = linkBudget(body.parameters);
          break;
        case "catalog": {
          exact(body, [...common, "source", "observedAt", "mediaType"]);
          const ref = record(body.source);
          exact(ref, ["commit", "path"]);
          const commit = hash(ref.commit),
            path = artifactPath(ref.path),
            bytes = client.load(repo, commit, path);
          kind = "catalog";
          source = { commit, path };
          data = catalogItem(
            {
              id: identifier,
              repo,
              product,
              commit,
              path,
              observedAt: body.observedAt as string,
              mediaType: body.mediaType,
            },
            bytes,
          );
          break;
        }
        default:
          return invalid("Unknown action");
      }
      const artifact = {
        schema: 1,
        kind,
        product,
        simulationOnly: true,
        requiresOperatorReview: true,
        createdAt: new Date().toISOString(),
        ...(source ? { source } : {}),
        data,
      };
      const path = `orbital/${kind}/${identifier}.json`,
        commit = client.save(
          repo,
          path,
          JSON.stringify(artifact),
          expectedHead,
          "Save offline orbital planning artifact",
        );
      return Response.json(
        {
          commit: { id: commit.id, parent: commit.parent, at: commit.at },
          path,
          artifact,
        },
        { headers },
      );
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof LabyrinthError
            ? (
                {
                  forbidden: 403,
                  not_found: 404,
                  invalid: 400,
                  conflict: 409,
                  capacity: 413,
                  integrity: 500,
                } as const
              )[error.code]
            : error instanceof ValidationError ||
                error instanceof SyntaxError ||
                error instanceof TypeError
              ? 400
              : 500;
      return Response.json(
        { error: status === 500 ? "internal_error" : "request_denied" },
        { status, headers },
      );
    }
  };
}
