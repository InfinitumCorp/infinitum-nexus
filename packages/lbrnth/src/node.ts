import type { IncomingMessage, ServerResponse } from "node:http";
import type { CidLabyrinth } from "./auth.ts";
import { LABYRINTH_HTTP_LIMIT, labyrinthCommand, labyrinthErrorStatus, labyrinthToken } from "./http.ts";
/** Mount at /api/labyrinth. Cookie tokens are supplied by the host's own existing CID cookie parser. */
export async function serveNodeLabyrinth(req: IncomingMessage, res: ServerResponse, auth?: CidLabyrinth, cookieToken?: string, onChange?: () => void): Promise<void> {
  const respond = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); };
  if (!auth) return respond(503, { error: "Labyrinth is not configured" });
  if (req.method !== "POST") return respond(405, { error: "POST required" });
  if (req.headers["x-labyrinth"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) return respond(403, { error: "JSON and Labyrinth request header required" });
  // An explicitly supplied invalid Authorization header must never fall back to cookies.
  const token = req.headers.authorization !== undefined ? labyrinthToken(req.headers.authorization) : cookieToken;
  if (!token) return respond(401, { error: "Cumulus ID sign-in required" });
  try { auth.session(token); } catch { return respond(401, { error: "Invalid Cumulus ID session or client organization" }); }
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += Buffer.byteLength(chunk);
      if (size > LABYRINTH_HTTP_LIMIT) return respond(413, { error: "Labyrinth request too large" });
      chunks.push(Buffer.from(chunk));
    }
    const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = await labyrinthCommand(auth, token, command);
    if (command.action === "consent" || command.action === "organization") onChange?.();
    respond(200, result ?? null);
  } catch (error) {
    const status = labyrinthErrorStatus(error);
    respond(status, { error: status >= 500 ? "Labyrinth unavailable" : "Labyrinth request denied" });
  }
}
