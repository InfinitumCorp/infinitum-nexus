// Regenerates openclaw.plugin.json from the tool definitions (the same output `openclaw plugins build` writes).
import { readFileSync, writeFileSync } from "node:fs";
import { pluginManifest } from "../src/manifest.ts";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
writeFileSync(new URL("../openclaw.plugin.json", import.meta.url), `${JSON.stringify(pluginManifest(pkg.version), null, 2)}\n`);
