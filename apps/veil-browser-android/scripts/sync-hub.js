/**
 * Copy the VEIL web app into the APK's assets as the offline Hub page, and
 * render launcher icons. Downloads, the service worker and the PWA manifest
 * stay out of the APK.
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { render } from "../../veil/scripts/make-icons.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = fileURLToPath(new URL("../../veil-web/", import.meta.url));

execSync(`node "${web}scripts/build.js"`, { stdio: "inherit" });

const hub = `${root}src/main/assets/hub/`;
rmSync(hub, { recursive: true, force: true });
mkdirSync(`${hub}lib`, { recursive: true });
mkdirSync(`${hub}icons`, { recursive: true });
for (const f of ["index.html", "app.js", "lib/trackers.js", "icons/icon-192.png"]) {
  cpSync(`${web}public/${f}`, `${hub}${f}`);
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(DENSITIES)) {
  const dir = `${root}src/main/res/mipmap-${d}/`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}ic_launcher.png`, render(px));
}
console.log("hub synced, launcher icons rendered");
