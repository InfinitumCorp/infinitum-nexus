import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import PostalMime from "postal-mime";
import { inboundAuthFromMta, MailError, type InboundMail } from "@infinitum/mail";
import type { FileStore } from "./files.ts";
import { storeInboundFiles, toInbound, type ParsedEmail } from "./inbound.ts";

/**
 * Outside mail for Node mode (src/server.ts on a server of our own, such as the Russia copy on
 * Yandex Cloud), where there is no Cloudflare Worker to receive and send it.
 *
 * In:  Postfix receives on port 25, OpenDKIM/OpenDMARC (and an SPF check) add Authentication-
 *      Results with our authserv-id, and a pipe transport runs scripts/postfix-deliver.ts, which
 *      POSTs the raw message here. This listener is bound to 127.0.0.1 only and wants a token.
 * Out: a timer drains the outbound queue through SMTP submission (src/smtp.ts).
 *
 *   MAIL_INBOUND_PORT        loopback port for Postfix deliveries (off when unset), e.g. 3011
 *   MAIL_INBOUND_TOKEN       shared secret the pipe script sends, 16+ characters
 *   MAIL_INBOUND_TOKEN_FILE  ... or a file holding it (readable by the pipe user too)
 *   MAIL_INBOUND_AUTHSERV_ID the authserv-id our milters write (OpenDMARC AuthservID), required
 */

/** Largest raw message accepted. Postfix's message_size_limit should be at or below this. */
export const MAX_INBOUND_BYTES = 30 * 1024 * 1024;

export interface InboundConfig {
  port: number;
  token: string;
  authservId: string;
}

/** Inbound settings from the environment, or null when MAIL_INBOUND_PORT isn't set. */
export function inboundConfigFromEnv(env: Record<string, string | undefined> = process.env): InboundConfig | null {
  if (!env.MAIL_INBOUND_PORT) return null;
  const port = Number(env.MAIL_INBOUND_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MAIL_INBOUND_PORT must be a port number, not "${env.MAIL_INBOUND_PORT}".`);
  const token = (env.MAIL_INBOUND_TOKEN ?? (env.MAIL_INBOUND_TOKEN_FILE ? readFileSync(env.MAIL_INBOUND_TOKEN_FILE, "utf8") : "")).trim();
  if (token.length < 16) throw new Error("MAIL_INBOUND_PORT needs MAIL_INBOUND_TOKEN (or MAIL_INBOUND_TOKEN_FILE) of at least 16 characters.");
  const authservId = env.MAIL_INBOUND_AUTHSERV_ID?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9.-]+$/.test(authservId)) throw new Error("MAIL_INBOUND_AUTHSERV_ID must be the authserv-id OpenDMARC/OpenDKIM write, e.g. mx.ru.cumuluscloud.app.");
  return { port, token, authservId };
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface InboundHandlerDeps {
  token: string;
  authservId: string;
  /** suite.mail.receive, wrapped so the result is saved. */
  receive(mail: InboundMail): Promise<{ delivered: string[]; unknown: string[] }>;
  files?: FileStore;
}

/** The envelope sender for a message, or "" when there's none we can deliver from. */
function senderFor(envelope: string, parsed: ParsedEmail): string {
  if (envelope) return envelope;
  // Null sender (<>): bounces and delivery reports. Show them as from the header address.
  return parsed.from?.address ?? "";
}

/**
 * POST /inbound?sender=<MAIL FROM>&recipient=<RCPT TO>   body = the raw message
 *   200 delivered · 404 no such mailbox (or full) · 422 refused for good (bad sender, DMARC fail)
 *   401/400/413 the request itself is wrong · 503 try again later
 * The pipe script turns these into Postfix exit codes (see postfix-pipe.ts).
 */
export function inboundHandler(deps: InboundHandlerDeps) {
  const reply = (res: ServerResponse, status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "POST" || url.pathname !== "/inbound") return reply(res, 404, { error: "Not found." });
    const token = String(req.headers["x-cumulus-inbound-token"] ?? "");
    if (!sameToken(token, deps.token)) return reply(res, 401, { error: "Wrong inbound token." });
    const recipient = (url.searchParams.get("recipient") ?? "").trim();
    if (!recipient) return reply(res, 400, { error: "recipient is required." });
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_INBOUND_BYTES) return reply(res, 413, { error: "Message too large." });

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_INBOUND_BYTES) return reply(res, 413, { error: "Message too large." });
        chunks.push(chunk as Buffer);
      }
    } catch {
      return reply(res, 400, { error: "The message didn't arrive whole." });
    }
    try {
      const raw = Buffer.concat(chunks);
      const parsed = (await PostalMime.parse(raw)) as ParsedEmail;
      const sender = senderFor((url.searchParams.get("sender") ?? "").trim(), parsed);
      let mail = toInbound(sender, recipient, parsed, (headers) => inboundAuthFromMta(headers, deps.authservId));
      if (deps.files && parsed.attachments?.length) mail = await storeInboundFiles(mail, parsed, deps.files);
      const result = await deps.receive(mail);
      if (!result.delivered.length) return reply(res, 404, { error: "No such Cumulus://Mail address, or the mailbox is full." });
      return reply(res, 200, { delivered: result.delivered });
    } catch (err) {
      // A refused message bounces for good; anything else (disk full, a bug) is retried by Postfix.
      if (err instanceof MailError) return reply(res, 422, { error: err.message, code: err.code });
      console.error("Inbound delivery failed:", (err as Error).message);
      return reply(res, 503, { error: "Cumulus couldn't store the message right now." });
    }
  };
}

/** Start the inbound listener on 127.0.0.1 only. */
export function startInboundListener(config: InboundConfig, deps: Omit<InboundHandlerDeps, "token" | "authservId">): Server {
  const handle = inboundHandler({ ...deps, token: config.token, authservId: config.authservId });
  const server = createServer((req, res) => void handle(req, res));
  server.listen(config.port, "127.0.0.1");
  return server;
}

/**
 * Drain the outbound queue every `intervalMs`, one run at a time. `deliver` is deliverOutbound
 * bound to the post office and an SMTP sender. Returns a stop function.
 */
export function startOutboundLoop(deliver: () => Promise<number>, intervalMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const sent = await deliver();
      if (sent) console.log(`Sent ${sent} message(s) outside Cumulus`);
    } catch (err) {
      console.error("Outbound run failed:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}

