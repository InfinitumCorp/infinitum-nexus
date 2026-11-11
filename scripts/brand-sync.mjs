// Copies packages/brand/brand.css into static UIs that can't import it.
// Run after editing brand.css:  pnpm brand:sync
import { copyFileSync } from "node:fs";
const src = new URL("../packages/brand/brand.css", import.meta.url);
const targets = ["../apps/spectre/public/brand.css", "../apps/veil/brand.css"];
for (const t of targets) {
  copyFileSync(src, new URL(t, import.meta.url));
  console.log("brand.css →", t.replace("../", ""));
}
