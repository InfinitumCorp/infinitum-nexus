// Shared helpers for Cumulus://Drive and its editors (Dox, Spreads, Podium).

/** Builds an element: el("button", { class: "primary", onClick }, ["Save"]). */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = !!v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

/** Sends people to sign in, then straight back here. */
export function signIn() {
  location.href = `/?next=${encodeURIComponent(location.pathname + location.hash)}`;
}

export async function api(path, { method = "GET", body, raw, type } = {}) {
  const headers = { "x-cumulus": "1" };
  if (body !== undefined && !raw) headers["content-type"] = "application/json";
  if (raw && type) headers["content-type"] = type;
  const res = await fetch(path, { method, headers, credentials: "same-origin", body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  if (res.status === 401) { signIn(); throw new ApiError(401, "Please sign in"); }
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Something went wrong (${res.status})`, data?.code);
  return data;
}

let toastTimer;
export function toast(message, action) {
  let box = document.querySelector(".toast");
  if (!box) { box = el("div", { class: "toast", role: "status", "aria-live": "polite" }); document.body.append(box); }
  box.replaceChildren(el("span", {}, [message]), action ? el("button", { class: "link", onClick: () => { box.hidden = true; action.run(); } }, [action.label]) : null);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 8000 : 4000);
}

export const formatBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);
export const when = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

export const KINDS = {
  dox: { app: "Cumulus://Dox", noun: "document", icon: "▤" },
  spreads: { app: "Cumulus://Spreads", noun: "spreadsheet", icon: "▦" },
  podium: { app: "Cumulus://Podium", noun: "presentation", icon: "▭" },
  folder: { app: "Cumulus://Drive", noun: "folder", icon: "▰" },
  file: { app: "Cumulus://Drive", noun: "file", icon: "▢" },
};

/**
 * Autosave for an editor: call changed() after each edit; it saves a second after typing stops,
 * keeps the document's version, and shows what's happening in `status`.
 * A conflict (someone else saved first) stops saving and offers a reload.
 */
export function autosaver({ id, version, getDoc, status, onSaved }) {
  let current = version;
  let timer = null;
  let inflight = null;
  let dirty = false;
  let stopped = false;
  const show = (text, cls = "") => { status.textContent = text; status.className = `save-status ${cls}`; };
  show("Saved");
  async function save() {
    if (stopped || !dirty) return;
    if (inflight) { await inflight; return save(); }
    dirty = false;
    show("Saving…");
    inflight = api(`/api/drive/items/${id}/doc`, { method: "PUT", body: { doc: getDoc(), version: current } })
      .then((item) => { current = item.version; show(dirty ? "Editing…" : "Saved"); onSaved?.(item); })
      .catch((e) => {
        if (e.status === 409) {
          stopped = true;
          show("Not saved", "bad");
          toast(e.message, { label: "Reload", run: () => location.reload() });
        } else if (e.status === 401) {
          stopped = true;
        } else {
          dirty = true;
          show(navigator.onLine === false ? "Offline: will save when you're back" : "Couldn't save. Retrying…", "bad");
          clearTimeout(timer);
          timer = setTimeout(save, 5000);
        }
      })
      .finally(() => { inflight = null; });
    return inflight;
  }
  window.addEventListener("online", () => { if (dirty) save(); });
  window.addEventListener("beforeunload", (e) => { if (dirty || inflight) { e.preventDefault(); e.returnValue = ""; } });
  return {
    changed() { if (stopped) return; dirty = true; show("Editing…"); clearTimeout(timer); timer = setTimeout(save, 1000); },
    flush: () => { clearTimeout(timer); return save(); },
    get version() { return current; },
  };
}

/** Downloads text or bytes made in the browser. */
export function saveFile(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Keeps only safe markup in rich text: no scripts, no event handlers, no outside links that run code. */
const ALLOWED = new Set(["P", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "SUB", "SUP", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "PRE", "CODE", "UL", "OL", "LI", "A", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SPAN", "DIV", "FONT", "MARK", "IMG"]);
const ATTRS = { A: ["href"], IMG: ["src", "alt", "width"], FONT: ["color"], TD: ["colspan", "rowspan"], TH: ["colspan", "rowspan"], "*": ["data-align", "data-checked"] };
export function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (!ALLOWED.has(child.tagName)) {
        if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "SVG", "MATH"].includes(child.tagName)) child.remove();
        else { walk(child); child.replaceWith(...child.childNodes); }
        continue;
      }
      for (const attr of [...child.attributes]) {
        const ok = (ATTRS[child.tagName] || []).includes(attr.name) || ATTRS["*"].includes(attr.name);
        const v = attr.value.trim().toLowerCase();
        const badUrl = (attr.name === "href" && !/^(https?:|mailto:|#)/.test(v)) || (attr.name === "src" && !/^(data:image\/(png|jpeg|gif|webp);|https:)/.test(v));
        if (!ok || badUrl) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The top bar every editor shares: back to Drive, the document's name (renamable by its owner),
 * save status, Share, and any extra buttons. Returns { bar, status }.
 */
export function editorBar({ item, kind, share, extra = [] }) {
  const status = el("span", { class: "save-status", role: "status", "aria-live": "polite" });
  const name = el("input", { class: "ed-name", value: item.name, "aria-label": "Name", readonly: item.role !== "owner" });
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); if (e.key === "Escape") { name.value = item.name; name.blur(); } });
  name.addEventListener("change", async () => {
    const next = name.value.trim();
    if (!next || next === item.name) { name.value = item.name; return; }
    try { const it = await api(`/api/drive/items/${item.id}`, { method: "PATCH", body: { name: next } }); item.name = it.name; name.value = it.name; document.title = `${it.name} · ${KINDS[kind].app}`; } catch (e) { toast(e.message); name.value = item.name; }
  });
  const bar = el("header", { class: "ed-bar" }, [
    el("a", { class: "back", href: item.role !== "owner" ? "#/shared" : item.parent ? `#/folder/${item.parent}` : "#/", "aria-label": "Back to Drive", title: "Back to Drive" }, ["‹"]),
    name,
    el("span", { class: "ed-app" }, [KINDS[kind].app]),
    status,
    el("div", { class: "ed-end" }, [...extra, item.role === "owner" ? el("button", { class: "primary", onClick: () => share(item) }, ["Share"]) : el("span", { class: "muted" }, [`Shared by ${item.owner}`])]),
  ]);
  return { bar, status };
}
