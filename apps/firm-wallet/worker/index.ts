/** Cloudflare Worker for $FIRM Wallet™ (free plan: static assets + a few small API routes). */
import { handleApi, SECURITY_HEADERS, type ApiEnv } from "./api.ts";

interface Env extends ApiEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = await handleApi(request, env);
    if (api) return api;
    const asset = await env.ASSETS.fetch(request);
    const res = new Response(asset.body, asset);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
    return res;
  },
};
