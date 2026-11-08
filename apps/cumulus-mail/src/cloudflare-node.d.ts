// The one Workers runtime module src/worker.ts uses (provided by workerd with nodejs_compat).
declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): { fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response> };
}
