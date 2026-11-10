/**
 * VEILBot Worker. A cron runs one crawl round a minute (crawl.js). The only HTTP answer is
 * GET /stats: how big the index is. Searching happens in the infinitumveil.app Worker,
 * which reads the same D1 database.
 */
import { crawlOnce } from "./crawl.js";

export default {
  async scheduled(event, env, ctx) {
    if (env.CRAWL_PAUSED === "1") return;
    ctx.waitUntil(crawlOnce(env.VEIL_INDEX, { hostsPerRun: Number(env.HOSTS_PER_RUN) || undefined }).then((s) => console.log("round", JSON.stringify(s))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/stats") {
      const db = env.VEIL_INDEX;
      const [pages, hosts, queued] = await Promise.all([
        db.prepare("SELECT count(*) AS n FROM pages").first(),
        db.prepare("SELECT count(*) AS n FROM hosts WHERE pages > 0").first(),
        db.prepare("SELECT count(*) AS n FROM frontier WHERE state = 0").first(),
      ]);
      return Response.json({ pages: pages.n, sites: hosts.n, queued: queued.n }, { headers: { "Cache-Control": "max-age=60" } });
    }
    return Response.redirect("https://infinitumveil.app/bot", 302);
  },
};
