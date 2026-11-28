// The Workers runtime modules src/server/worker.ts uses (provided by workerd with nodejs_compat).
declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): { fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response> };
}
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectStateLike;
    protected env: Env;
    constructor(ctx: DurableObjectStateLike, env: Env);
  }
  export interface DurableObjectStateLike {
    storage: {
      sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } };
      transactionSync<T>(fn: () => T): T;
    };
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  }
}
