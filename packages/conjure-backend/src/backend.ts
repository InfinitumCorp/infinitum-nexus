import { LabyrinthError } from "@infinitum/lbrnth";
import { CONJURE_PRODUCT_PRESETS } from "@infinitum/conjure";
import type { ConjureService } from "./service.ts";
import { object, exact, id, fail } from "./schema.ts";
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
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536))
    throw new HttpError(413);
  if (!request.body) fail("invalid", "JSON required");
  const reader = request.body!.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 65536) {
        await reader.cancel();
        throw new HttpError(413);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return object(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ),
  );
}
export function conjureBackend(service: ConjureService) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        match = /^\/api\/predict\/([a-z][a-z0-9-]{0,63})$/.exec(url.pathname);
      if (
        !match ||
        url.search ||
        !CONJURE_PRODUCT_PRESETS.some((p) => p.product === match[1])
      )
        throw new HttpError(404);
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
      const body = await readBody(request),
        { action, ...input } = body,
        product = match[1]!,
        token = bearer[1]!;
      let result: unknown;
      switch (action) {
        case "create":
          result = service.create(token, product, input);
          break;
        case "record":
          result = service.record(token, product, input);
          break;
        case "advance":
          result = await service.advance(token, product, input);
          break;
        case "stop":
          result = await service.advance(token, product, input, true);
          break;
        case "load":
          exact(input, ["repo", "id"]);
          result = service.load(token, product, id(input.repo), id(input.id));
          break;
        default:
          fail("invalid", "Unknown action");
      }
      return Response.json(result, { headers });
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof LabyrinthError
            ? (
                {
                  forbidden: 403,
                  invalid: 400,
                  not_found: 404,
                  conflict: 409,
                  capacity: 413,
                  integrity: 500,
                } as const
              )[error.code]
            : error instanceof SyntaxError ||
                error instanceof TypeError ||
                error instanceof RangeError
              ? 400
              : 500;
      return Response.json(
        { error: status === 500 ? "internal_error" : "request_denied" },
        { status, headers },
      );
    }
  };
}
