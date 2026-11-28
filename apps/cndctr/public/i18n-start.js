// Interface language: detected from the browser, remembered when chosen from the
// menu, English fallback. Catalogs are generated at build time by
// packages/i18n (extract.ts + translate.ts); nothing is translated at runtime.
import { startI18n } from "/i18n.js";
import catalogs from "/i18n-catalogs.js";

const slot = document.createElement("div");
slot.className = "lang-float";
document.body.append(slot);
startI18n({ catalogs, switcher: slot });
