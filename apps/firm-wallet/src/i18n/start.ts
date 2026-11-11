// Interface language: detected from the browser, remembered when chosen from the menu,
// English fallback. Catalogs are generated at build time (packages/i18n translate.ts)
// and committed, so nothing is translated at runtime and the wallet works offline and
// in Russia. Addresses, amounts and token names never match a catalog key.
import { startI18n } from "@infinitum/i18n";
import "@infinitum/i18n/i18n.css";
import catalogs from "./catalogs.js";

let slot = document.getElementById("lang-switch");
if (!slot) {
  slot = document.createElement("div");
  slot.className = "lang-float";
  document.body.append(slot);
}
export const i18n = startI18n({ catalogs, switcher: slot });
