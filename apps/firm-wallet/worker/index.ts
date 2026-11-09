/** Cloudflare Worker for $FIRM Wallet™ (free plan: static assets + a few small API routes). */
import { handleApi, securityHeadersFor, type ApiEnv } from "./api.ts";

interface Env extends ApiEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await handleApi(request, env);
    if (api) return api;
    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    res.headers.delete("x-frame-options");
    for (const [k, v] of Object.entries(securityHeadersFor(new URL(request.url).pathname))) res.headers.set(k, v);
    return res;
  },
};
