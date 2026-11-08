import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import PostalMime from "postal-mime";
import { MailError } from "@infinitum/mail";
import handler, { receiveMail, sendScheduledMail } from "./vercel.ts";
import { toInbound } from "./inbound.ts";

/**
 * Cumulus://Mail on Cloudflare Workers. Static files (public/) are served as Workers static assets;
 * everything else reaches the same hosted handler as the Vercel build, through Workers' Node.js
 * HTTP server support. State lives in Supabase behind the nexus-store function.
 * Configuration comes from the Worker's variables and secrets (see cloudflare.config.ts).
 * A once-a-minute cron trigger sends scheduled mail that is due.
 * Email Routing hands mail sent to @cumuluscloud.app from outside to email().
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

export default {
  fetch: http.fetch,
  async scheduled() {
    const sent = await sendScheduledMail();
    if (sent) console.log(`Sent ${sent} scheduled message(s)`);
  },
  async email(message: IncomingEmail) {
    const parsed = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
    try {
      const result = await receiveMail(toInbound(message.from, message.to, parsed));
      if (!result.delivered.length) message.setReject("No such Cumulus://Mail address, or the mailbox is full.");
    } catch (err) {
      // A refused message (bad or forged sender) bounces for good; anything else (the data store
      // is down) throws, so the sending server keeps the message and retries later.
      if (err instanceof MailError) message.setReject(err.message);
      else throw err;
    }
  },
};
