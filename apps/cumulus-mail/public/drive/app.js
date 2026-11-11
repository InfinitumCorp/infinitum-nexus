// Cumulus://Drive: files and folders on your Cumulus://ID, plus Dox, Spreads and Podium.
import { el, api, toast, formatBytes, when, KINDS, signIn } from "./shared.js";

const root = document.getElementById("app");
const S = { me: null, list: null, route: [], busy: false };

/* ---------------- shell ---------------- */

const APPS = [["Mail", "/"], ["Drive", "/drive/"], ["Dox", "/drive/#/new/dox"], ["Spreads", "/drive/#/new/spreads"], ["Podium", "/drive/#/new/podium"]];

function appsMenu() {
  const menu = el("div", { class: "menu", hidden: true, role: "menu" }, APPS.map(([label, href]) => el("a", { href, role: "menuitem" }, [label])));
  const btn = el("button", { class: "icon", "aria-label": "Cumulus apps", "aria-haspopup": "menu", onClick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, ["⋮⋮"]);
  document.addEventListener("click", () => { menu.hidden = true; });
  return el("div", { class: "menu-wrap" }, [btn, menu]);
}

function accountMenu() {
  const menu = el("div", { class: "menu right", hidden: true, role: "menu" }, [
    el("p", { class: "menu-note" }, [S.me.email]),
    el("a", { href: "/#/account", role: "menuitem" }, ["Your Cumulus://ID"]),
    el("button", { role: "menuitem", onClick: async () => { await api("/api/auth/signout", { method: "POST", body: {} }).catch(() => {}); location.href = "/"; } }, ["Sign out"]),
  ]);
  const btn = el("button", { class: "avatar", "aria-label": `Account: ${S.me.email}`, onClick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, [S.me.username.slice(0, 1).toUpperCase()]);
  document.addEventListener("click", () => { menu.hidden = true; });
  return el("div", { class: "menu-wrap" }, [btn, menu]);
}

function topBar() {
  const q = el("input", { type: "search", placeholder: "Search Drive", "aria-label": "Search Drive", value: S.route[0] === "search" ? decodeURIComponent(S.route[1] || "") : "" });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") location.hash = q.value.trim() ? `#/search/${encodeURIComponent(q.value.trim())}` : "#/"; });
  return el("header", { class: "bar" }, [
    el("a", { class: "mark", href: "#/" }, ["Cumulus://", el("span", {}, ["Drive"])]),
    el("label", { class: "search" }, [el("span", { class: "glass", "aria-hidden": "true" }, ["⌕"]), q]),
    el("div", { class: "bar-end" }, [appsMenu(), accountMenu()]),
  ]);
}

function newMenu() {
  const files = el("input", { type: "file", multiple: true, hidden: true, onChange: () => { upload([...files.files]); files.value = ""; } });
  const item = (label, fn) => el("button", { role: "menuitem", onClick: () => { menu.hidden = true; fn(); } }, [label]);
  const menu = el("div", { class: "menu", hidden: true, role: "menu" }, [
    item("New folder", newFolder),
    item("Upload files", () => files.click()),
    el("hr"),
    item("Cumulus://Dox document", () => newDoc("dox")),
    item("Cumulus://Spreads spreadsheet", () => newDoc("spreads")),
    item("Cumulus://Podium presentation", () => newDoc("podium")),
  ]);
  document.addEventListener("click", () => { menu.hidden = true; });
  return el("div", { class: "menu-wrap" }, [el("button", { class: "new", "aria-haspopup": "menu", onClick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } }, [el("span", { "aria-hidden": "true" }, ["+"]), "New"]), menu, files]);
}

function sidebar() {
  const view = S.route[0] || "folder";
  const nav = [["folder", "My Drive", "#/"], ["recent", "Recent", "#/recent"], ["starred", "Starred", "#/starred"], ["shared", "Shared with me", "#/shared"], ["trash", "Trash", "#/trash"]];
  const usage = S.list?.usage;
  return el("nav", { class: "side", "aria-label": "Drive" }, [
    newMenu(),
    ...nav.map(([id, label, href]) => el("a", { href, "aria-current": view === id ? "page" : null }, [label])),
    usage ? el("div", { class: "storage" }, [
      el("div", { class: "meter" }, [el("span", { style: null, dataset: { pct: String(Math.max(1, Math.round(usage.pct))) } })]),
      el("p", {}, [`${usage.label} used`]),
      el("p", { class: "muted" }, [`Drive ${formatBytes(usage.byProduct.cloud)} · Mail ${formatBytes(usage.byProduct.mail)}`]),
    ]) : null,
  ]);
}

/* ---------------- actions ---------------- */

const currentFolder = () => (S.route[0] === "folder" && S.route[1] ? S.route[1] : null);

async function newFolder() {
  const name = prompt("Folder name", "Untitled folder");
  if (name == null) return;
  try { await api("/api/drive/folders", { method: "POST", body: { name, parent: currentFolder() } }); toast("Folder created"); load(); } catch (e) { toast(e.message); }
}

async function newDoc(kind, parent = currentFolder()) {
  try {
    const item = await api("/api/drive/docs", { method: "POST", body: { kind, parent } });
    location.hash = `#/${kind}/${item.id}`;
  } catch (e) { toast(e.message); }
}

function upload(files) {
  if (!files.length) return;
  const parent = currentFolder();
  const panel = document.querySelector(".uploads") || document.body.appendChild(el("div", { class: "uploads", role: "status" }));
  panel.hidden = false;
  let left = files.length;
  for (const f of files) {
    const row = el("div", { class: "up" }, [el("span", { class: "up-name" }, [f.name]), el("progress", { max: 100, value: 0 })]);
    panel.append(row);
    if (f.size > 50 * 1024 * 1024) { row.append(el("span", { class: "bad" }, ["Over 50 MB"])); if (!--left) setTimeout(() => { panel.hidden = true; panel.replaceChildren(); }, 6000); continue; }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/drive/upload?name=${encodeURIComponent(f.name)}${parent ? `&parent=${parent}` : ""}`);
    xhr.setRequestHeader("x-cumulus", "1");
    xhr.setRequestHeader("content-type", f.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) row.querySelector("progress").value = Math.round((e.loaded / e.total) * 100); };
    xhr.onload = () => {
      if (xhr.status === 401) return signIn();
      if (xhr.status !== 200) { let m = "Upload failed"; try { m = JSON.parse(xhr.responseText).error; } catch {} row.append(el("span", { class: "bad" }, [m])); }
      else row.querySelector("progress").value = 100;
      if (!--left) { load(); setTimeout(() => { panel.hidden = true; panel.replaceChildren(); }, 3000); }
    };
    xhr.onerror = () => { row.append(el("span", { class: "bad" }, ["Upload failed"])); if (!--left) load(); };
    xhr.send(f);
  }
}

const open = (it) => {
  if (it.kind === "folder") location.hash = `#/folder/${it.id}`;
  else location.hash = `#/${it.kind}/${it.id}`;
};

async function patch(it, body, message) {
  try { await api(`/api/drive/items/${it.id}`, { method: "PATCH", body }); if (message) toast(message, body.trashed ? { label: "Undo", run: () => patch(it, { trashed: false }) } : null); load(); } catch (e) { toast(e.message); }
}

async function moveDialog(it) {
  const dialog = el("dialog", { class: "dialog" });
  const list = el("div", { class: "folder-pick" }, ["Loading…"]);
  let picked = null;
  const crumbs = el("p", { class: "muted" });
  async function show(folder) {
    const data = await api(`/api/drive${folder ? `?folder=${folder}` : ""}`);
    picked = folder;
    crumbs.textContent = ["My Drive", ...data.path.map((p) => p.name)].join(" / ");
    list.replaceChildren(...data.items.filter((x) => x.kind === "folder" && x.id !== it.id).map((f) => el("button", { onClick: () => show(f.id) }, [`▰ ${f.name}`])), data.items.some((x) => x.kind === "folder" && x.id !== it.id) ? null : el("p", { class: "muted" }, ["No folders here."]));
  }
  dialog.append(el("h2", {}, [`Move “${it.name}”`]), crumbs, list, el("div", { class: "row end" }, [
    el("button", { class: "quiet", onClick: () => show(null) }, ["My Drive"]),
    el("button", { class: "outline", onClick: () => dialog.close() }, ["Cancel"]),
    el("button", { class: "primary", onClick: async () => { dialog.close(); await patch(it, { parent: picked }, "Moved"); } }, ["Move here"]),
  ]));
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  show(null).catch((e) => { list.textContent = e.message; });
}

export function shareDialog(it, onChange) {
  const dialog = el("dialog", { class: "dialog" });
  const who = el("input", { placeholder: "name@cumuluscloud.app", "aria-label": "Share with", autocapitalize: "none", spellcheck: "false" });
  const people = el("ul", { class: "people" });
  const err = el("p", { class: "bad", role: "alert" });
  const draw = (item) => {
    people.replaceChildren(...item.sharedWith.map((p) => el("li", {}, [el("span", {}, [p]), el("button", { class: "quiet", onClick: async () => {
      try { const next = await api(`/api/drive/items/${item.id}/share/${encodeURIComponent(p)}`, { method: "DELETE" }); draw(next); onChange?.(next); } catch (e) { err.textContent = e.message; }
    } }, ["Remove"])])));
    if (!item.sharedWith.length) people.append(el("li", { class: "muted" }, ["Only you can open this."]));
  };
  const add = async () => {
    err.textContent = "";
    if (!who.value.trim()) return;
    try { const next = await api(`/api/drive/items/${it.id}/share`, { method: "POST", body: { with: who.value.trim() } }); who.value = ""; draw(next); onChange?.(next); toast("Shared. They'll get a notice in Cumulus://Mail."); } catch (e) { err.textContent = e.message; }
  };
  who.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  dialog.append(
    el("h2", {}, [`Share “${it.name}”`]),
    el("p", { class: "muted" }, ["People you add can open and edit it. Sharing a folder shares everything in it."]),
    el("div", { class: "row" }, [who, el("button", { class: "primary", onClick: add }, ["Share"])]),
    err, people,
    el("div", { class: "row end" }, [
      el("button", { class: "outline", onClick: async () => { await navigator.clipboard?.writeText(`${location.origin}/drive/#/${it.kind === "folder" ? "folder" : it.kind}/${it.id}`).catch(() => {}); toast("Link copied. It only works for people you've shared with."); } }, ["Copy link"]),
      el("button", { class: "primary", onClick: () => dialog.close() }, ["Done"]),
    ]),
  );
  draw(it);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  who.focus();
}

function rowMenu(it) {
  const trash = S.route[0] === "trash";
  const mine = it.role === "owner";
  const menu = el("div", { class: "menu right", hidden: true, role: "menu" });
  const item = (label, fn, cls) => el("button", { role: "menuitem", class: cls, onClick: (e) => { e.stopPropagation(); menu.hidden = true; fn(); } }, [label]);
  if (trash) {
    menu.append(item("Restore", () => patch(it, { trashed: false }, "Restored")), item("Delete forever", async () => {
      if (!confirm(`Delete “${it.name}” forever? This can't be undone.`)) return;
      try { await api(`/api/drive/items/${it.id}`, { method: "DELETE" }); toast("Deleted forever"); load(); } catch (e) { toast(e.message); }
    }, "bad"));
  } else {
    menu.append(item("Open", () => open(it)));
    if (it.kind !== "folder") menu.append(item("Download", () => { location.href = `/api/drive/items/${it.id}/download`; }));
    if (mine) {
      menu.append(
        item("Rename", () => { const n = prompt("New name", it.name); if (n && n !== it.name) patch(it, { name: n }, "Renamed"); }),
        item("Move", () => moveDialog(it)),
        item(it.starred ? "Remove star" : "Star", () => patch(it, { starred: !it.starred })),
        item("Share", () => shareDialog(it, () => load())),
        el("hr"),
        item("Move to trash", () => patch(it, { trashed: true }, `“${it.name}” moved to trash`), "bad"),
      );
    } else {
      menu.append(item("Remove from Shared with me", async () => { await api(`/api/drive/items/${it.id}/leave`, { method: "POST", body: {} }).catch((e) => toast(e.message)); load(); }));
    }
  }
  document.addEventListener("click", () => { menu.hidden = true; });
  return el("div", { class: "menu-wrap" }, [el("button", { class: "icon", "aria-label": `More actions for ${it.name}`, "aria-haspopup": "menu", onClick: (e) => { e.stopPropagation(); document.querySelectorAll(".menu").forEach((m) => { if (m !== menu) m.hidden = true; }); menu.hidden = !menu.hidden; } }, ["⋯"]), menu]);
}

/* ---------------- views ---------------- */

const TITLES = { recent: "Recent", starred: "Starred", shared: "Shared with me", trash: "Trash" };

function listView() {
  const data = S.list;
  const view = S.route[0] || "folder";
  const crumbs = view === "folder"
    ? el("ol", { class: "crumbs" }, [el("li", {}, [el("a", { href: "#/" }, ["My Drive"])]), ...data.path.map((p) => el("li", {}, [el("a", { href: `#/folder/${p.id}` }, [p.name])]))])
    : el("h1", { class: "view-title" }, [view === "search" ? `Results for “${decodeURIComponent(S.route[1] || "")}”` : TITLES[view] || "My Drive"]);
  const quick = view === "folder" ? el("div", { class: "quick" }, ["dox", "spreads", "podium"].map((k) => el("button", { class: `tile ${k}`, onClick: () => newDoc(k) }, [el("span", { class: "tile-icon", "aria-hidden": "true" }, [KINDS[k].icon]), el("span", {}, [`New ${KINDS[k].noun}`]), el("small", {}, [KINDS[k].app])]))) : null;
  const actions = view === "trash" && data.items.length ? el("button", { class: "outline", onClick: async () => {
    if (!confirm("Delete everything in the trash forever? This can't be undone.")) return;
    try { const r = await api("/api/drive/trash/empty", { method: "POST", body: {} }); toast(`Deleted ${r.removed} item(s) forever`); load(); } catch (e) { toast(e.message); }
  } }, ["Empty trash"]) : null;
  const rows = data.items.map((it) => el("tr", { tabindex: 0, onDblclick: () => (view === "trash" ? null : open(it)), onKeydown: (e) => { if (e.key === "Enter" && view !== "trash") open(it); } }, [
    el("td", {}, [el("div", { class: "name" }, [el("span", { class: `kind ${it.kind}`, "aria-hidden": "true" }, [KINDS[it.kind]?.icon ?? "▢"]), view === "trash" ? el("span", {}, [it.name]) : el("a", { href: it.kind === "folder" ? `#/folder/${it.id}` : `#/${it.kind}/${it.id}` }, [it.name]), it.starred ? el("span", { class: "star", "aria-label": "Starred" }, ["★"]) : null, it.sharedWith.length ? el("span", { class: "shared-tag", title: it.sharedWith.join(", ") }, ["Shared"]) : null])]),
    el("td", { class: "owner" }, [it.role === "owner" ? "me" : it.owner]),
    el("td", { class: "date" }, [when(it.updatedAt)]),
    el("td", { class: "size" }, [it.kind === "folder" ? "—" : formatBytes(it.size)]),
    el("td", { class: "act" }, [rowMenu(it)]),
  ]));
  const empty = el("div", { class: "empty" }, [
    el("p", {}, [view === "trash" ? "The trash is empty." : view === "shared" ? "Nothing has been shared with you yet." : view === "starred" ? "Star files to find them here." : view === "search" ? "Nothing matches." : "Drop files here, or use New."]),
  ]);
  const table = el("table", { class: "files" }, [
    el("thead", {}, [el("tr", {}, [el("th", {}, ["Name"]), el("th", { class: "owner" }, ["Owner"]), el("th", { class: "date" }, ["Modified"]), el("th", { class: "size" }, ["Size"]), el("th", { class: "act" }, [el("span", { class: "visually-hidden" }, ["Actions"])])])]),
    el("tbody", {}, rows),
  ]);
  const main = el("main", { class: "main", id: "main" }, [el("div", { class: "main-head" }, [crumbs, actions]), quick, data.items.length ? table : empty]);
  // Drag and drop files anywhere in the list.
  if (view === "folder") {
    main.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); main.classList.add("drop"); } });
    main.addEventListener("dragleave", (e) => { if (e.target === main) main.classList.remove("drop"); });
    main.addEventListener("drop", (e) => { e.preventDefault(); main.classList.remove("drop"); upload([...(e.dataTransfer?.files || [])]); });
  }
  return main;
}

async function fileView(id) {
  const it = await api(`/api/drive/items/${id}`);
  const src = `/api/drive/items/${id}/download?inline=1`;
  const t = it.type || "";
  const preview = t.startsWith("image/") ? el("img", { src, alt: it.name })
    : t.startsWith("video/") ? el("video", { src, controls: true })
    : t.startsWith("audio/") ? el("audio", { src, controls: true })
    : el("p", { class: "muted" }, ["No preview for this kind of file."]);
  return el("main", { class: "main", id: "main" }, [
    el("div", { class: "main-head" }, [el("h1", { class: "view-title" }, [it.name]), el("div", { class: "row" }, [
      el("a", { class: "primary button", href: `/api/drive/items/${id}/download` }, ["Download"]),
      it.role === "owner" ? el("button", { class: "outline", onClick: () => shareDialog(it) }, ["Share"]) : null,
    ])]),
    el("p", { class: "muted" }, [`${formatBytes(it.size)} · ${t || "file"} · ${it.role === "owner" ? "Yours" : `Shared by ${it.owner}`} · Modified ${when(it.updatedAt)}`]),
    el("div", { class: "preview" }, [preview]),
  ]);
}

/* ---------------- routing ---------------- */

const EDITORS = { dox: "./dox.js", spreads: "./spreads.js", podium: "./podium.js" };

let seq = 0; // bumps on every navigation, so a slow answer never draws over a newer page

async function load() {
  const mine = seq;
  const [view, arg] = S.route;
  const q = view === "search" ? `?q=${encodeURIComponent(decodeURIComponent(arg || ""))}` : view && view !== "folder" ? `?view=${view}` : arg ? `?folder=${arg}` : "";
  try {
    const list = await api(`/api/drive${q}`);
    if (mine !== seq) return;
    S.list = list;
    drawDrive();
  } catch (e) {
    if (mine === seq && e.status !== 401) drawDrive(e.message);
  }
}

function drawDrive(error) {
  document.title = "Cumulus://Drive";
  root.className = "drive";
  root.replaceChildren(topBar(), el("div", { class: "layout" }, [sidebar(), error ? el("main", { class: "main" }, [el("p", { class: "bad" }, [error]), el("a", { href: "#/" }, ["Back to My Drive"])]) : listView()]));
  document.querySelectorAll(".meter span[data-pct]").forEach((s) => { s.style.width = `${s.dataset.pct}%`; });
}

async function route() {
  const mine = ++seq;
  S.route = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [view, arg] = S.route;
  try {
    if (view === "new" && EDITORS[arg]) return await newDoc(arg, null);
    if (EDITORS[view] && arg) {
      root.className = "editor";
      root.replaceChildren(el("p", { class: "loading" }, ["Opening…"]));
      const mod = await import(EDITORS[view]);
      const { item, doc } = await api(`/api/drive/items/${arg}/doc`);
      if (mine !== seq) return;
      document.title = `${item.name} · ${KINDS[view].app}`;
      return mod.open({ root, item, doc, me: S.me, share: shareDialog });
    }
    if (view === "file" && arg) {
      const page = await fileView(arg);
      if (mine !== seq) return;
      root.className = "drive";
      root.replaceChildren(topBar(), el("div", { class: "layout" }, [sidebar(), page]));
      return;
    }
    if (S.list) drawDrive();
    await load();
  } catch (e) {
    if (e.status === 401) return;
    root.className = "drive";
    root.replaceChildren(topBar(), el("div", { class: "layout" }, [sidebar(), el("main", { class: "main" }, [el("p", { class: "bad" }, [e.message]), el("a", { href: "#/" }, ["Back to My Drive"])])]));
  }
}

async function boot() {
  const me = await api("/api/id/me").catch(() => null);
  if (!me || me.signedIn === false) return signIn();
  S.me = me;
  window.addEventListener("hashchange", route);
  route();
}

boot();
