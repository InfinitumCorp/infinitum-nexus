/**
 * Generate the VEIL web app's derived files from the extension's sources:
 *   public/lib/trackers.js   tracker list from apps/veil/lib/privacy.js
 *   public/icons/*.png       icons from the icon.svg design
 *   public/build.js          build stamp
 *   node apps/veil-web/scripts/build.js
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TRACKERS } from "../../veil/lib/privacy.js";
import { render } from "../../veil/scripts/make-icons.js";

const pub = fileURLToPath(new URL("../public/", import.meta.url));
mkdirSync(`${pub}lib`, { recursive: true });
mkdirSync(`${pub}icons`, { recursive: true });

let sha = "dev";
try { sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch {}
const stamp = `web ${new Date().toISOString().slice(0, 10)} · ${sha}`;

writeFileSync(
  `${pub}lib/trackers.js`,
  `/* Generated from apps/veil/lib/privacy.js by scripts/build.js. Do not edit. */\n` +
  `window.VEIL_TRACKERS = ${JSON.stringify([...TRACKERS])};\nwindow.VEIL_BUILD = ${JSON.stringify(stamp)};\n`,
);
for (const s of [192, 512]) writeFileSync(`${pub}icons/icon-${s}.png`, render(s));
console.log(`veil-web: ${TRACKERS.length} trackers, icons 192/512, ${stamp}`);
