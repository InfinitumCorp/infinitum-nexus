/**
 * VEIL content script.
 * 1. Strips tracking parameters from the page URL.
 * 2. In the signed-in workspace only, reports that a person is active so
 *    the background can credit eligible minutes. The report carries no URL,
 *    title or content, just three booleans.
 * 3. Tells the background how many tracking parameters it stripped (a
 *    number only), for the VEIL shield's per-site Protected count.
 * 4. Holds a form that would send personal data without encryption or to
 *    another site, and asks first (lib/content-pii.js).
 * 5. Warns when a protected password is typed on a site it doesn't belong
 *    to. Only typed values whose length matches a protected password go to
 *    the background for the hash check; nothing leaves the extension.
 * 6. Fills a generated password into the page when the user asks.
 *
 * Keep TRACKERS identical to lib/privacy.js (privacy.test.js checks it).
 */
(() => {
  const TRACKERS = [
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid",
    "igshid", "li_fat_id", "mc_cid", "mc_eid", "_hsenc", "_hsmi", "oly_enc_id",
    "oly_anon_id", "vero_id", "wickedid", "s_cid", "_ga", "_gl",
  ];

  function stripTrackers(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    let removed = 0;
    for (const t of TRACKERS) {
      if (u.searchParams.has(t)) { u.searchParams.delete(t); removed++; }
    }
    return removed ? { url: u.toString(), removed } : null;
  }

  const report = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  function cleanNow() {
    const result = stripTrackers(location.href);
    if (!result) return null;
    history.replaceState(history.state, "", result.url);
    report({ type: "protection", stripped: result.removed });
    return result.url;
  }

  // ---- Personal data in forms ----
  const confirmed = new WeakSet();
  document.addEventListener("submit", (e) => {
    const form = e.target;
    const pii = globalThis.VeilPII;
    if (!pii || !(form instanceof HTMLFormElement) || confirmed.has(form)) return;
    const submitter = e.submitter;
    const action = submitter?.hasAttribute?.("formaction") ? submitter.formAction : form.action || location.href;
    const kinds = pii.formKinds([...form.elements]);
    const why = pii.reasons(location.href, action, kinds);
    if (!why.length) return;
    let host = "";
    try { host = new URL(action, location.href).hostname; } catch {}
    if (window.confirm(pii.message(kinds, why, host))) {
      confirmed.add(form);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // ---- Protected-password reuse ----
  let guardLengths = [];
  const checked = new WeakMap();
  let timer = null;

  function banner(text, actions) {
    document.getElementById("veil-guard-host")?.remove();
    const host = document.createElement("div");
    host.id = "veil-guard-host";
    const shadow = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.setAttribute("role", "alert");
    box.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 24px));background:#1a0b0b;color:#fde2e2;border:1px solid #f87171;border-radius:10px;padding:12px 14px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.4)";
    const p = document.createElement("div");
    p.textContent = text;
    box.append(p);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap";
    for (const [label, fn] of actions) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.style.cssText = "font:inherit;border:1px solid #f87171;background:transparent;color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer";
      b.onclick = () => { host.remove(); fn?.(); };
      row.append(b);
    }
    box.append(row);
    shadow.append(box);
    document.documentElement.append(host);
  }

  async function checkField(field) {
    const value = field.value;
    if (!guardLengths.includes(value.length) || checked.get(field) === value) return;
    checked.set(field, value);
    const result = await report({ type: "pwCheck", value });
    if (!result?.reused) return;
    const sites = (result.hosts ?? []).join(", ");
    banner(`VEIL: you just typed your protected password on ${location.hostname}. It belongs to ${sites}. If you didn't mean to give it to this site, don't submit, and change the password if you already did.`, [
      ["Not this site, clear the field", () => { field.value = ""; field.dispatchEvent(new Event("input", { bubbles: true })); }],
      ["This site is mine too", () => report({ type: "pwTrust", id: result.id })],
    ]);
  }

  document.addEventListener("input", (e) => {
    const field = e.target;
    if (!(field instanceof HTMLInputElement) || field.type !== "password" || !guardLengths.length) return;
    clearTimeout(timer);
    timer = setTimeout(() => checkField(field), 350);
  }, true);

  function fillPassword(value) {
    const active = document.activeElement;
    const scope = active?.form ?? document.querySelector("input[type=password]")?.form ?? document;
    const fields = [...scope.querySelectorAll("input[type=password]")]
      .filter((f) => !f.disabled && !f.readOnly && (f === active || !f.value));
    for (const f of fields) {
      f.value = value;
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return fields.length;
  }

  // ---- Activity reporting (signed-in workspace only) ----
  const THROTTLE_MS = 15_000;
  const EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];
  let lastSent = 0;
  let listening = false;

  function onInput(e) {
    if (!e.isTrusted) return; // synthetic events never earn
    const now = Date.now();
    if (now - lastSent < THROTTLE_MS) return;
    lastSent = now;
    chrome.runtime.sendMessage({
      type: "activity",
      trusted: true,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
    }).catch(() => {});
  }

  function setListening(on) {
    if (on === listening) return;
    listening = on;
    for (const ev of EVENTS) {
      if (on) window.addEventListener(ev, onInput, { capture: true, passive: true });
      else window.removeEventListener(ev, onInput, { capture: true });
    }
  }

  chrome.storage.local.get(["autoClean", "workspace", "pwGuardLengths"]).then((s) => {
    guardLengths = Array.isArray(s.pwGuardLengths) ? s.pwGuardLengths : [];
    if (s.autoClean) cleanNow();
    setListening(s.workspace === "authenticated");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pwGuardLengths) {
      guardLengths = Array.isArray(changes.pwGuardLengths.newValue) ? changes.pwGuardLengths.newValue : [];
    }
    if (area === "local" && changes.workspace) {
      setListening(changes.workspace.newValue === "authenticated");
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "cleanUrl") {
      const cleaned = cleanNow();
      sendResponse(cleaned ? { cleaned: true, url: cleaned } : { cleaned: false });
    }
    if (msg?.type === "fillPassword" && typeof msg.value === "string") {
      sendResponse({ filled: fillPassword(msg.value) });
    }
  });
})();
