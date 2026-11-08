import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { handleApi } from "./worker/api.ts";

/** Run the Worker's /api routes inside `vite dev`, so local development needs no Cloudflare account. */
function devApi(): Plugin {
  return {
    name: "firm-wallet-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const request = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const response = await handleApi(request, { CONJURE_URL: process.env.CONJURE_URL, CONJURE_KEY: process.env.CONJURE_KEY });
        if (!response) return next();
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), devApi()],
  build: { target: "es2022", sourcemap: false },
  server: { port: 5178 },
  test: { environment: "node" },
} as Parameters<typeof defineConfig>[0]);
