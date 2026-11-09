import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import PostalMime from "postal-mime";
import { MailError } from "@infinitum/mail";
import handler, { deliverOutboundMail, receiveMail, sendScheduledMail, useFileStore } from "./vercel.ts";
import { cloudflareSender, type EmailBinding } from "./outbound.ts";
import { r2FileStore, type FileStore, type R2BucketLike } from "./files.ts";
import { storeInboundFiles, toInbound } from "./inbound.ts";

/**
 * Cumulus://Mail on Cloudflare Workers. Static files (public/) are served as Workers static assets;
 * everything else reaches the same hosted handler as the Vercel build, through Workers' Node.js
 * HTTP server support. State lives in Supabase behind the nexus-store function.
 * Configuration comes from the Worker's variables and secrets (see cloudflare.config.ts).
 * A once-a-minute cron trigger sends scheduled mail that is due.
 * Email Routing hands mail sent to @cumuluscloud.app from outside to email().
 * Mail to outside addresses goes out on the same cron through Email Sending (the EMAIL binding).
 */
const PORT = 8080;
createServer((req, res) => void handler(req, res)).listen(PORT);

const http = httpServerHandler({ port: PORT });

/** The parts of Cloudflare's ForwardableEmailMessage that Cumulus uses. */
interface IncomingEmail {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

interface Env {
  EMAIL?: EmailBinding;
  /** R2 bucket for attachment contents. Without it, attaching files is turned off. */
  MAIL_FILES?: R2BucketLike;
  /** Service binding to the downloads site (Worker cumulus-downloads), served at /download/. */
  DOWNLOADS_SITE?: { fetch(request: Request): Promise<Response> };
}

let files: FileStore | undefined;
/** Hand the R2 bucket to the app before it is first built. */
function configure(env: Env) {
  if (!files && env.MAIL_FILES) {
    files = r2FileStore(env.MAIL_FILES);
    useFileStore(files);
  }
}

export default {
  fetch(request: Request, env: Env, ctx: unknown) {
    // The downloads page (Worker cumulus-downloads) is also served here, at /download/.
    const url = new URL(request.url);
    if (env.DOWNLOADS_SITE && (url.pathname === "/download" || url.pathname === "/downloads" || url.pathname === "/downloads/")) {
      return Response.redirect(`${url.origin}/download/`, 301);
    }
    if (env.DOWNLOADS_SITE && url.pathname.startsWith("/download/")) {
      const inner = new URL(url);
      inner.pathname = url.pathname.slice("/download".length);
      return env.DOWNLOADS_SITE.fetch(new Request(inner, request));
    }
    configure(env);
    return http.fetch(request, env, ctx);
  },
  async scheduled(_controller: unknown, env: Env) {
    configure(env);
    const sent = await sendScheduledMail();
    if (sent) console.log(`Sent ${sent} scheduled message(s)`);
    // Without the binding (Email Sending not set up), outside mail stays queued.
    if (env.EMAIL) {
      const out = await deliverOutboundMail(cloudflareSender(env.EMAIL, files));
      if (out) console.log(`Sent ${out} message(s) outside Cumulus`);
    }
  },
  async email(message: IncomingEmail, env: Env) {
    configure(env);
    const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
    try {
      let inbound = toInbound(message.from, message.to, parsed);
      if (files && parsed.attachments?.length) inbound = await storeInboundFiles(inbound, parsed, files);
      const result = await receiveMail(inbound);
      if (!result.delivered.length) message.setReject("No such Cumulus://Mail address, or the mailbox is full.");
    } catch (err) {
      // A refused message (bad or forged sender) bounces for good; anything else (the data store
      // is down) throws, so the sending server keeps the message and retries later.
      if (err instanceof MailError) message.setReject(err.message);
      else throw err;
    }
  },
};
