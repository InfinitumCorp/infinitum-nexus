#!/usr/bin/env node
/**
 * Builds +SPCTR for Vercel using the Build Output API (v3).
 *   node apps/spectre/scripts/build-vercel.mjs      (run from the repository root)
 *
 * Produces .vercel/output with:
 *   static/              the web app (served from Vercel's CDN)
 *   functions/api.func/  one bundled Node function for every /api/* route
 *   config.json          routes and security headers
 *
 * Plain JavaScript on purpose: it runs on Vercel's build machine before anything is installed.
 * esbuild comes from node_modules if present, otherwise from npx.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(app, "../..");
const out = join(root, ".vercel/output");
const ESBUILD_VERSION = "0.25.12";

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "static"), { recursive: true });
mkdirSync(join(out, "functions/api.func"), { recursive: true });

// 1. Static web app.
cpSync(join(app, "public"), join(out, "static"), { recursive: true });

// 2. Map every workspace package (@infinitum/*) straight to its TypeScript source,
//    so the bundle doesn't depend on how node_modules was (or wasn't) installed.
const alias = {};
for (const group of ["packages", "apps"]) {
  for (const dir of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pkgFile = join(root, group, dir.name, "package.json");
    if (!existsSync(pkgFile)) continue;
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    const entry = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
    const target = typeof entry === "string" ? entry : entry?.default ?? entry?.import ?? "./src/index.ts";
    if (pkg.name?.startsWith("@infinitum/")) alias[pkg.name] = join(root, group, dir.name, target);
  }
}

// 3. Bundle the function.
const options = {
  entryPoints: [join(app, "src/server/vercel.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(out, "functions/api.func/index.mjs"),
  alias,
  // Node's own modules stay external; everything else is inlined.
  packages: "bundle",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
  legalComments: "none",
};

let esbuild;
try {
  esbuild = createRequire(join(root, "package.json"))("esbuild");
} catch {
  try {
    esbuild = createRequire("/opt/npm-tools/package.json")("esbuild");
  } catch {
    esbuild = null;
  }
}
if (esbuild) {
  await esbuild.build(options);
} else {
  const args = [
    "--yes", `esbuild@${ESBUILD_VERSION}`, options.entryPoints[0], "--bundle", "--platform=node", "--format=esm",
    "--target=node22", `--outfile=${options.outfile}`, "--log-level=warning", "--legal-comments=none",
    `--banner:js=${options.banner.js}`,
    ...Object.entries(alias).map(([k, v]) => `--alias:${k}=${v}`),
  ];
  execFileSync("npx", args, { stdio: "inherit", cwd: root });
}

writeFileSync(join(out, "functions/api.func/.vc-config.json"), JSON.stringify({
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 60,
}, null, 2));
writeFileSync(join(out, "functions/api.func/package.json"), JSON.stringify({ type: "module" }));

// 4. Routes and headers. Same security headers the app sends itself.
const security = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self' https://api2.amplitude.com https://api.amplitude.com; frame-ancestors 'none'",
};
writeFileSync(join(out, "config.json"), JSON.stringify({
  version: 3,
  routes: [
    // Public form and booking pages may be embedded on other sites; nothing else may be framed.
    { src: "/((?!form\\.html$|book\\.html$).*)", headers: security, continue: true },
    { src: "/(form|book)\\.html", headers: { ...security, "X-Frame-Options": undefined, "Content-Security-Policy": security["Content-Security-Policy"].replace("frame-ancestors 'none'", "frame-ancestors *") }, continue: true },
    { src: "/", headers: { "Cache-Control": "no-cache" }, continue: true },
    { src: "/index.html", headers: { "Cache-Control": "no-cache" }, continue: true },
    { src: "/api/(.*)", dest: "/api" },
    { handle: "filesystem" },
    { src: "/(.*)", status: 404, dest: "/index.html" },
  ],
}, null, 2));

console.log(`Built .vercel/output (function bundle: ${(readFileSync(options.outfile).length / 1024).toFixed(0)} KB)`);
