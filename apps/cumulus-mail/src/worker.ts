import { createServer } from "node:http";
import { httpServerHandler } from "cloudflare:node";
import handler, { sendScheduledMail } from "./vercel.ts";

/**
 * Cumulus://Mail on Cloudflare Workers. Static files (public/) are served as Workers static assets;
 * everything else reaches the same hosted handler as the Vercel build, through Workers' Node.js
 * HTTP server support. State lives in Supabase behind the nexus-store function.
 * Configuration comes from the Worker's variables and secrets (see cloudflare.config.ts).
 * A once-a-minute cron trigger sends scheduled mail that is due.
 */
const PORT = 8080;
createServer((req, res) => void handler(req, res)).listen(PORT);

const http = httpServerHandler({ port: PORT });

export default {
  fetch: http.fetch,
  async scheduled() {
    const sent = await sendScheduledMail();
    if (sent) console.log(`Sent ${sent} scheduled message(s)`);
  },
};
