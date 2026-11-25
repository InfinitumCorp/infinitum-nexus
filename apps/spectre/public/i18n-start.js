// Interface language: detected from the browser, remembered when chosen from the
// menu, English fallback. Catalogs are generated at build time by
// packages/i18n (extract.ts + translate.ts); nothing is translated at runtime.
import { startI18n } from "/i18n.js";
import catalogs from "/i18n-catalogs.js";

// The menu lives in the sidebar's #lang-switch slot (inside the ☰ menu on phones), so it
// never sits over the dashboard. Screens without the sidebar (sign-in, booking) keep the
// small corner float, and body.lang-floating pads the page so it covers nothing there.
const slot = document.createElement("div");
startI18n({ catalogs, switcher: slot });

function place() {
  const home = document.getElementById("lang-switch");
  if (home) {
    if (slot.parentElement !== home) home.append(slot);
    slot.className = "";
  } else if (slot.parentElement !== document.body) {
    slot.className = "lang-float";
    document.body.append(slot);
  }
  document.body.classList.toggle("lang-floating", !home);
}
place();
new MutationObserver(place).observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
