// FABRIC++ Teams web client. Plain DOM, no innerHTML for anything people type.

const $ = (s) => document.querySelector(s);
const EMOJI = ["👍", "❤️", "😂", "🎉", "👀", "🙏", "✅", "🔥", "😮", "😢", "🚀", "💯"];
const state = {
  me: null, wsId: localStorage.getItem("team.ws") || "", bar: null, channel: null, messages: [], hasMore: false,
  thread: null, editing: null, files: [], view: null, typing: new Map(), events: null, lastActivitySeen: localStorage.getItem("team.activity") || "",
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function showError(message) {
  const box = $("#error");
  box.hidden = !message;
  box.textContent = message || "";
  if (message) setTimeout(() => { if (box.textContent === message) box.hidden = true; }, 6000);
}

async function api(path, options = {}) {
  const init = { ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } };
  if (options.body && typeof options.body !== "string") init.body = JSON.stringify(options.body);
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `request failed (${res.status})`);
  return body;
}
const T = (p) => `/api/team${p}`;
const tryRun = (fn) => async (...args) => { try { await fn(...args); } catch (e) { showError(e.message); } };

// ---------- formatting ----------

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
function inline(text, mentions) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(https?:\/\/[^\s<>"')\]]+)|(@[a-z0-9._-]+)|(#[a-z0-9_-]+)|(fabric:message\/[0-9a-f-]{36})|(:[a-z0-9_+-]{1,40}:)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h("code", {}, t.slice(1, -1)));
    else if (m[2]) out.push(h("strong", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[3]) out.push(h("em", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[4]) out.push(h("s", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[5] && isTeamLink(t)) out.push(h("a", { href: t, onclick: (e) => { e.preventDefault(); followTeamLink(t); } }, /#\/m\//.test(t) ? "view message" : t));
    else if (m[5]) out.push(h("a", { href: t, target: "_blank", rel: "noopener noreferrer" }, t));
    else if (m[6]) {
      const name = t.slice(1).toLowerCase().replace(/[._-]+$/, "");
      const me = state.me && (name === state.me.username || ["channel", "here", "everyone"].includes(name));
      out.push(h("span", { class: `mention${me ? " me" : ""}` }, t));
    } else if (m[7]) out.push(h("a", { href: "#", class: "chan", onclick: (e) => { e.preventDefault(); openChannelByName(t.slice(1)); } }, t));
    else if (m[8]) out.push(h("a", { href: "#", onclick: (e) => { e.preventDefault(); jumpTo(t.split("/")[1]); } }, "view message"));
    else if (m[9]) out.push(emojiNode(t));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function format(text) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) { frag.append(h("pre", {}, h("code", {}, part.replace(/^\n/, "")))); return; }
    const lines = part.split("\n");
    let list = null;
    for (const line of lines) {
      if (/^\s*[-•*]\s+/.test(line)) {
        list = list || frag.appendChild(h("ul"));
        list.append(h("li", {}, ...inline(line.replace(/^\s*[-•*]\s+/, ""))));
        continue;
      }
      list = null;
      if (/^>\s?/.test(line)) frag.append(h("blockquote", {}, ...inline(line.replace(/^>\s?/, ""))));
      else if (line.trim() === "") frag.append(h("br"));
      else frag.append(h("p", {}, ...inline(line)));
    }
  });
  return frag;
}

/** A :name: custom emoji as an image, or the text itself if the workspace has no such emoji. */
function emojiNode(code) {
  const name = code.slice(1, -1).toLowerCase();
  if (!state.emoji?.has(name)) return code;
  return h("img", { class: "t-emoji", src: T(`/workspaces/${state.wsId}/emoji/${name}`), alt: code, title: code, loading: "lazy" });
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const when = (iso) => `${day(iso)} ${time(iso)}`;
const size = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const chanLabel = (c) => c.kind === "public" ? `# ${c.name}` : c.kind === "private" ? `🔒 ${c.name}` : c.name;
const personName = (p) => `${p.displayName}${p.statusEmoji ? ` ${p.statusEmoji}` : ""}`;
const dot = (p) => h("span", { class: `dot ${p.presence}${p.dnd ? " dnd" : ""}`, title: p.dnd ? "Do not disturb" : p.presence }, "");

// ---------- dialogs ----------

function dialog(title, fields, okLabel = "OK") {
  const dlg = $("#dialog");
  $("#dialog-title").textContent = title;
  const body = $("#dialog-body");
  body.replaceChildren();
  const inputs = {};
  for (const f of fields) {
    if (f.note) { body.append(h("p", { class: "meta" }, f.note)); continue; }
    const id = `dlg-${f.name}`;
    let input;
    if (f.type === "textarea") input = h("textarea", { id, class: "input", rows: f.rows || 6, maxlength: f.max || 50000 });
    else if (f.type === "select") input = h("select", { id, class: "input" }, ...f.options.map(([v, l]) => h("option", { value: v }, l)));
    else if (f.type === "checkbox") input = h("input", { id, type: "checkbox" });
    else input = h("input", { id, class: "input", type: f.type || "text", maxlength: f.max || 200, placeholder: f.placeholder || "", required: f.required });
    if (f.type === "checkbox") input.checked = !!f.value;
    else if (f.value !== undefined) input.value = f.value;
    inputs[f.name] = input;
    body.append(h("label", { class: "field", for: id }, h("span", {}, f.label)), input);
  }
  $("#dialog-ok").textContent = okLabel;
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === "ok" ? Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.type === "checkbox" ? el.checked : el.value])) : null);
    dlg.returnValue = "";
    dlg.showModal();
    Object.values(inputs)[0]?.focus();
  });
}

function menu(anchor, items) {
  document.querySelector(".t-menu")?.remove();
  const box = h("div", { class: "t-menu", role: "menu" }, ...items.filter(Boolean).map(([label, fn]) => h("button", { type: "button", role: "menuitem", onclick: () => { box.remove(); tryRun(fn)(); } }, label)));
  const r = anchor.getBoundingClientRect();
  box.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 4)}px`;
  box.style.left = `${Math.max(8, Math.min(window.innerWidth - 240, r.left))}px`;
  document.body.append(box);
  setTimeout(() => document.addEventListener("click", () => box.remove(), { once: true }), 0);
  box.querySelector("button")?.focus();
}

function emojiPicker(anchor, onPick) {
  const custom = [...(state.emoji || [])].slice(0, 24).map((name) => [emojiNode(`:${name}:`), () => onPick(`:${name}:`)]);
  menu(anchor, [...EMOJI.map((e) => [e, () => onPick(e)]), ...custom, ["Other…", async () => {
    const r = await dialog("React with", [{ name: "emoji", label: "Emoji or :short_code:", max: 42, required: true }]);
    if (r?.emoji) await onPick(r.emoji);
  }]]);
  document.querySelector(".t-menu")?.classList.add("emoji");
}

// ---------- sidebar ----------

async function loadSidebar() {
  state.bar = await api(T(`/workspaces/${state.wsId}`));
  const bar = state.bar;
  state.emoji = new Set(bar.emoji || []);
  $("#me-button").hidden = false;
  $("#me-button").textContent = `${bar.me.statusEmoji ? `${bar.me.statusEmoji} ` : ""}${bar.me.displayName}${bar.me.dnd ? (bar.me.quietHours ? " · off hours" : " · DND") : bar.me.presence === "away" ? " · away" : ""}`;
  // Notifications come back on their own when a pause or your quiet hours end, so look again then.
  clearTimeout(dndTimer);
  if (bar.me.dndUntil) dndTimer = setTimeout(() => soon(loadSidebar), Math.min(Math.max(new Date(bar.me.dndUntil).getTime() - Date.now(), 0) + 1000, 6 * 3_600_000));
  $("#count-saved").textContent = bar.saved || "";
  $("#count-scheduled").textContent = bar.scheduled || "";
  $("#count-reminders").textContent = bar.reminders || "";
  $("#count-tasks").textContent = bar.tasks || "";
  $("#count-drafts").textContent = bar.drafts || "";
  const row = (c) => h("li", {}, h("button", {
    type: "button", class: `${c.unread && !c.muted ? "unread" : ""}${c.muted ? " muted" : ""}`, "aria-current": state.channel?.id === c.id ? "true" : null,
    onclick: tryRun(() => openChannel(c.id)),
  }, c.kind === "dm" && c.people?.[0] ? dot(c.people[0]) : null, h("span", { class: "name" }, chanLabel(c)), c.huddle ? h("span", { class: "t-huddle-mark", title: `Huddle · ${c.huddle.people}` }, "🎧") : null, c.mentions ? h("span", { class: "badge" }, String(c.mentions)) : null));
  const all = [...bar.channels, ...bar.direct];
  $("#starred").replaceChildren(...all.filter((c) => c.starred).map(row));
  $("#starred").parentElement.hidden = !all.some((c) => c.starred);
  const sectionIds = new Set((bar.sections || []).map((s) => s.id));
  const placed = (c) => c.starred || (c.sectionId && sectionIds.has(c.sectionId));
  $("#sections").replaceChildren(...(bar.sections || []).map((s, i) => {
    const items = all.filter((c) => !c.starred && c.sectionId === s.id);
    const unread = items.some((c) => c.unread && !c.muted);
    return h("div", { class: "t-section" },
      h("div", { class: "t-section-head" },
        h("button", { type: "button", class: `link t-section-toggle${unread && s.collapsed ? " strong" : ""}`, "aria-expanded": String(!s.collapsed), onclick: tryRun(() => sectionUpdate(s, { collapsed: !s.collapsed })) }, `${s.collapsed ? "▸" : "▾"} ${s.name}`),
        h("button", { type: "button", class: "link", "aria-label": `${s.name} options`, onclick: (e) => menu(e.currentTarget, [
          ["Rename section", async () => { const r = await dialog("Rename section", [{ name: "name", label: "Name", value: s.name, max: 60, required: true }]); if (r) await sectionUpdate(s, { name: r.name }); }],
          i > 0 && ["Move up", () => sectionUpdate(s, { position: i - 1 })],
          i < bar.sections.length - 1 && ["Move down", () => sectionUpdate(s, { position: i + 1 })],
          ["Delete section", async () => { if (confirm(`Delete the section “${s.name}”? Its channels go back to Channels and Direct messages.`)) { await api(T(`/sections/${s.id}`), { method: "DELETE" }); await loadSidebar(); } }],
        ]) }, "⋯")),
      s.collapsed ? h("ul", { class: "t-list" }, ...items.filter((c) => state.channel?.id === c.id || (c.unread && !c.muted)).map(row)) : h("ul", { class: "t-list" }, ...items.map(row)),
      !s.collapsed && !items.length ? h("p", { class: "meta t-section-empty" }, "Use ⋯ → Move to section on a channel.") : null,
    );
  }));
  $("#channels").replaceChildren(...bar.channels.filter((c) => !placed(c)).map(row));
  $("#direct").replaceChildren(...bar.direct.filter((c) => !placed(c)).map(row));
  const unread = all.reduce((n, c) => n + (c.muted ? 0 : c.mentions), 0);
  document.title = `${unread ? `(${unread}) ` : ""}${bar.workspace.name} · FABRIC Teams`;
}

async function sectionUpdate(s, body) {
  await api(T(`/sections/${s.id}`), { method: "PATCH", body });
  await loadSidebar();
}

async function moveToSection(c) {
  const sections = state.bar.sections || [];
  const r = await dialog(`Move ${chanLabel(c)}`, [
    { name: "sectionId", label: "Section", type: "select", value: c.sectionId || "", options: [["", c.kind === "dm" || c.kind === "group" ? "Direct messages (default)" : "Channels (default)"], ...sections.map((s) => [s.id, s.name]), ["+", "New section…"]] },
  ], "Move");
  if (!r) return;
  let sectionId = r.sectionId || null;
  if (sectionId === "+") {
    const n = await dialog("New section", [{ name: "name", label: "Name", max: 60, required: true, placeholder: "Projects" }], "Create");
    if (!n) return;
    sectionId = (await api(T(`/workspaces/${state.wsId}/sections`), { method: "POST", body: { name: n.name } })).id;
  }
  await api(T(`/channels/${c.id}/prefs`), { method: "PUT", body: { sectionId } });
  await loadSidebar();
}

async function loadWorkspaces() {
  const { workspaces } = await api(T("/workspaces"));
  if (workspaces.length === 0) {
    $("#onboard").hidden = false;
    $("#app").hidden = true;
    $("#search-form").hidden = true;
    return false;
  }
  if (!workspaces.some((w) => w.id === state.wsId)) state.wsId = workspaces[0].id;
  localStorage.setItem("team.ws", state.wsId);
  $("#ws-select").replaceChildren(...workspaces.map((w) => h("option", { value: w.id, selected: w.id === state.wsId }, w.name)), h("option", { value: "+" }, "+ Add a workspace"));
  $("#onboard").hidden = true;
  $("#app").hidden = false;
  $("#search-form").hidden = false;
  await loadSidebar();
  return true;
}

// ---------- channel ----------

async function openChannel(id, around) {
  saveDraft();
  state.view = null;
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-current", "false"));
  state.channel = await api(T(`/channels/${id}`));
  const q = around ? `?around=${around}` : "";
  const page = await api(T(`/channels/${id}/messages${q}`));
  state.messages = page.messages;
  state.hasMore = page.hasMore;
  setRoute(around ? `#/m/${around}` : `#/c/${id}`);
  renderHead();
  renderMessages(around);
  $("#composer").hidden = false;
  restoreDraft();
  if (state.channel.member && state.channel.unread > 0) await api(T(`/channels/${id}/read`), { method: "POST", body: {} });
  await loadSidebar();
  if (!around) $("#text").focus();
}

async function openChannelByName(name) {
  const c = [...state.bar.channels].find((x) => x.name === name);
  if (c) return openChannel(c.id);
  const { channels } = await api(T(`/workspaces/${state.wsId}/channels?q=${encodeURIComponent(name)}`));
  const hit = channels.find((x) => x.name === name);
  if (hit) await openChannel(hit.id);
  else showError(`No channel #${name}`);
}

// ---------- links ----------
// The address follows what you are looking at, so reload keeps your place, Back and Forward work,
// and a copied link opens a message for anyone who can see it: /team#/c/<channel>, #/m/<message>, #/v/<view>.

const VIEWS = ["activity", "threads", "unreads", "saved", "drafts", "scheduled", "reminders", "tasks", "files", "people"];
let routing = false;
const routeNow = () => { const m = /^#\/(c|m|v)\/([a-z0-9-]{1,40})$/.exec(location.hash); return m ? { kind: m[1], id: m[2] } : null; };
const messageLink = (id) => `${location.origin}/team#/m/${id}`;
const isTeamLink = (url) => url.startsWith(`${location.origin}/team#/`);
function setRoute(hash, replace = false) {
  if (routing || location.hash === hash) return;
  history[replace ? "replaceState" : "pushState"](null, "", hash);
}
async function followTeamLink(url) {
  history.pushState(null, "", url.slice(url.indexOf("#")));
  const r = routeNow();
  if (r) await applyRoute(r);
}
/** Go where a link points, switching workspace if it is in another one. False if it isn't there or you can't see it. */
async function applyRoute(r) {
  routing = true;
  try {
    let wsId = state.wsId;
    if (r.kind === "c") wsId = (await api(T(`/channels/${r.id}`))).workspaceId;
    if (r.kind === "m") wsId = (await api(T(`/channels/${(await api(T(`/messages/${r.id}`))).channelId}`))).workspaceId;
    if (r.kind === "v" && !VIEWS.includes(r.id)) throw new Error("unknown view");
    if (wsId !== state.wsId) { state.wsId = wsId; await start({ open: false }); }
    if (r.kind === "c") await openChannel(r.id);
    else if (r.kind === "m") await jumpTo(r.id);
    else await showView(r.id);
    return true;
  } catch {
    showNote("That link isn't available to you.");
    return false;
  } finally {
    routing = false;
  }
}
window.addEventListener("popstate", () => { const r = routeNow(); if (r && state.bar) tryRun(applyRoute)(r); });

async function jumpTo(messageId) {
  const m = await api(T(`/messages/${messageId}`));
  await openChannel(m.channelId, messageId);
  if (m.parentId) await openThread(m.parentId);
}

function renderHead() {
  const c = state.channel;
  const head = $("#head");
  head.replaceChildren(
    h("div", { class: "t-title" },
      h("h2", {}, chanLabel(c)),
      c.member ? h("button", { type: "button", class: "link", "aria-pressed": String(c.starred), title: c.starred ? "Unstar" : "Star", onclick: tryRun(async () => { await api(T(`/channels/${c.id}/prefs`), { method: "PUT", body: { starred: !c.starred } }); c.starred = !c.starred; renderHead(); await loadSidebar(); }) }, c.starred ? "★" : "☆") : null,
      c.archived ? h("span", { class: "meta" }, "archived") : null,
      c.posting === "admins" ? h("span", { class: "meta", title: c.threadReplies ? "Only admins and the channel creator can post; everyone can reply in threads" : "Only admins and the channel creator can post" }, "📣 announcements") : null,
    ),
    h("p", { class: "meta t-topic" }, c.topic || c.purpose || (c.kind === "dm" ? "Direct message" : c.kind === "group" ? "Group conversation" : "Add a topic")),
    h("div", { class: "t-row t-head-actions" },
      h("button", { type: "button", class: "btn small", onclick: tryRun(showMembers) }, `${c.memberCount} ${c.memberCount === 1 ? "member" : "members"}`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(showPins) }, `Pins${c.pins ? ` ${c.pins}` : ""}`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(showCanvas) }, c.canvas ? "Canvas •" : "Canvas"),
      h("button", { type: "button", class: "btn small", onclick: tryRun(() => showList()) }, `List${c.openTasks ? ` ${c.openTasks}` : ""}`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(() => showFiles(c.id)) }, "Files"),
      huddleButton(c),
      !c.member && !c.archived ? h("button", { type: "button", class: "btn primary small", onclick: tryRun(async () => { await api(T(`/channels/${c.id}/join`), { method: "POST", body: {} }); await openChannel(c.id); }) }, "Join channel") : null,
      h("button", { type: "button", class: "btn small", "aria-label": "Channel settings", onclick: (e) => channelMenu(e.currentTarget) }, "…"),
    ),
  );
  $("#bookmarks").replaceChildren(
    ...c.bookmarks.map((b) => h("li", {}, h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, b.title),
      h("button", { type: "button", class: "link", "aria-label": `Remove ${b.title}`, onclick: tryRun(async () => { await api(T(`/bookmarks/${b.id}`), { method: "DELETE" }); await refreshChannel(); }) }, "×"))),
    c.member ? h("li", {}, h("button", { type: "button", class: "link", onclick: tryRun(addBookmark) }, "+ Add a bookmark")) : null,
  );
  const readOnly = c.member && !c.archived && c.canPost === false;
  $("#composer").querySelector("textarea").placeholder = c.archived ? "This channel is archived" : readOnly ? `Only admins and the channel creator can post in ${chanLabel(c)}${c.threadReplies ? ". You can reply in threads." : "."}` : `Message ${chanLabel(c)}`;
  $("#text").disabled = c.archived || !c.member || readOnly;
  $("#composer").classList.toggle("read-only", !!readOnly);
}

function channelMenu(anchor) {
  const c = state.channel;
  const named = c.kind === "public" || c.kind === "private";
  menu(anchor, [
    named && ["Edit topic", async () => { const r = await dialog("Topic", [{ name: "topic", label: "Topic", value: c.topic, max: 250 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); } }],
    named && ["Edit description", async () => { const r = await dialog("Description", [{ name: "purpose", label: "Description", value: c.purpose, max: 250 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); } }],
    named && ["Rename", async () => { const r = await dialog("Rename channel", [{ name: "name", label: "Name", value: c.name, max: 80 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); await loadSidebar(); } }],
    c.kind !== "dm" && c.member && ["Add people", async () => { const r = await dialog("Add people", [{ name: "people", label: "Usernames, separated by spaces", required: true }]); if (r) { await api(T(`/channels/${c.id}/invite`), { method: "POST", body: { people: r.people.split(/[\s,]+/) } }); await refreshChannel(); } }],
    c.kind !== "dm" && ["Workflows", () => showWorkflows()],
    c.kind !== "dm" && ["Incoming webhooks", () => showWebhooks()],
    c.member && [c.muted ? "Unmute" : "Mute", async () => { await api(T(`/channels/${c.id}/prefs`), { method: "PUT", body: { muted: !c.muted } }); await refreshChannel(); await loadSidebar(); }],
    c.member && ["Move to section…", () => moveToSection(c)],
    c.member && ["Notifications…", () => editNotifications(c)],
    named && c.member && (["owner", "admin"].includes(state.bar.workspace.role) || c.createdBy === state.me.sub) && ["Posting permissions…", () => editPosting(c)],
    named && c.member && (["owner", "admin"].includes(state.bar.workspace.role) || c.createdBy === state.me.sub) && ["Insights", () => showInsights(c, 30)],
    c.kind === "public" && c.member && !c.isDefault && !c.archived && ["owner", "admin"].includes(state.bar.workspace.role) && ["Make private…", () => makePrivate(c)],
    c.member && ["Mark as read", async () => { await api(T(`/channels/${c.id}/read`), { method: "POST", body: {} }); await loadSidebar(); }],
    named && !c.archived && ["Archive channel", async () => { if (confirm(`Archive #${c.name}? People can still read it.`)) { await api(T(`/channels/${c.id}/archive`), { method: "POST", body: { archived: true } }); await refreshChannel(); await loadSidebar(); } }],
    named && c.archived && ["Unarchive channel", async () => { await api(T(`/channels/${c.id}/archive`), { method: "POST", body: { archived: false } }); await refreshChannel(); await loadSidebar(); }],
    c.member && c.kind !== "dm" && !c.isDefault && ["Leave", async () => { await api(T(`/channels/${c.id}/leave`), { method: "POST", body: {} }); state.channel = null; await loadSidebar(); await openChannel(state.bar.channels[0].id); }],
  ]);
}

async function makePrivate(c) {
  const r = await dialog(`Make #${c.name} private`, [
    { note: `Only the ${c.memberCount} ${c.memberCount === 1 ? "person" : "people"} in it now will be able to find it, read its history or be added by its members. Everyone else loses access straight away.` },
    { note: "This can't be undone: a private channel can't be made public again." },
  ], "Make private");
  if (!r) return;
  await api(T(`/channels/${c.id}`), { method: "PATCH", body: { private: true } });
  await refreshChannel();
  await loadSidebar();
}

// Channel insights: activity counts for the channel's creator and workspace admins. No message content.
async function showInsights(c, days) {
  const s = await api(T(`/channels/${c.id}/insights?days=${days}`));
  const max = Math.max(1, ...s.perDay.map((d) => d.messages));
  const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const stat = (n, label) => h("div", { class: "t-stat" }, h("strong", {}, String(n)), h("span", { class: "meta" }, label));
  panel(`Insights · ${chanLabel(c)}`,
    h("div", { class: "t-row", role: "group", "aria-label": "Period" }, ...[7, 30, 90].map((d) =>
      h("button", { type: "button", class: `btn small${d === days ? " primary" : ""}`, "aria-pressed": String(d === days), onclick: tryRun(() => showInsights(c, d)) }, `${d} days`))),
    h("div", { class: "t-stats" },
      stat(s.messages, s.messages === 1 ? "message" : "messages"),
      stat(s.activePeople, s.activePeople === 1 ? "person posted" : "people posted"),
      stat(s.members, s.members === 1 ? "member" : "members"),
      stat(s.joined, "joined")),
    h("p", { class: "meta" }, `${s.replies} ${s.replies === 1 ? "was a thread reply" : "were thread replies"}${s.fromApps ? `, ${s.fromApps} from apps` : ""}.`),
    h("div", { class: "t-bars", role: "img", "aria-label": `Messages per day, ${day(s.perDay[0].date)} to ${day(s.perDay.at(-1).date)}. Busiest day: ${max} messages.` },
      ...s.perDay.map((d) => {
        // Set through the DOM, not a style attribute, which the page's CSP blocks.
        const bar = h("span", { class: "t-bar", title: `${day(d.date)}: ${d.messages}` });
        bar.style.height = `${Math.round((d.messages / max) * 100)}%`;
        return bar;
      })),
    h("p", { class: "t-row meta t-bars-axis" }, h("span", {}, day(s.perDay[0].date)), h("span", {}, day(s.perDay.at(-1).date))),
    h("h3", {}, "Most active"),
    s.topPeople.length ? h("ol", { class: "t-top" }, ...s.topPeople.map((p) => h("li", {}, h("span", {}, p.person.displayName), h("span", { class: "meta" }, String(p.messages)))))
      : h("p", { class: "meta" }, "Nobody has posted in this period."),
    h("p", { class: "meta" }, "Counts only. Deleted and system messages are left out. Only you can see this."));
}

let dndTimer = 0;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// When you get notifications. Outside these hours you are in do-not-disturb, and others see that.
async function editSchedule() {
  const { schedule } = await api(T(`/workspaces/${state.wsId}/notification-schedule`));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const s = schedule || { days: [1, 2, 3, 4, 5], from: 9 * 60, to: 18 * 60, timeZone };
  const order = [1, 2, 3, 4, 5, 6, 0];
  const r = await dialog("Notification schedule", [
    { note: `Get notifications only on these days and times. Outside them you're shown as do-not-disturb. Times are in ${schedule && schedule.timeZone !== timeZone ? `${schedule.timeZone} (saved) — saving uses your current time zone, ${timeZone}` : timeZone}.` },
    { name: "on", label: "Use a schedule", type: "checkbox", value: !!schedule },
    { name: "from", label: "From", type: "time", value: hhmm(s.from) },
    { name: "to", label: "Until", type: "time", value: hhmm(Math.min(s.to, 1439)) },
    ...order.map((d) => ({ name: `d${d}`, label: DAY_NAMES[d], type: "checkbox", value: s.days.includes(d) })),
  ], "Save");
  if (!r) return;
  const days = order.filter((d) => r[`d${d}`]);
  const body = r.on ? { schedule: { days, from: r.from, to: r.to, timeZone } } : { schedule: null };
  if (r.on && !days.length) throw new Error("Pick at least one day, or turn the schedule off");
  await api(T(`/workspaces/${state.wsId}/notification-schedule`), { method: "PUT", body });
  await loadSidebar();
}

// Owners can have old messages deleted automatically. Off unless they turn it on.
async function editRetention(w) {
  const choices = [["", "Keep all messages"], ["30", "Delete after 30 days"], ["90", "Delete after 90 days"], ["180", "Delete after 6 months"], ["365", "Delete after 1 year"], ["730", "Delete after 2 years"]];
  const current = w.retentionDays == null ? "" : String(w.retentionDays);
  if (current && !choices.some(([v]) => v === current)) choices.push([current, `Delete after ${current} days`]);
  const r = await dialog("Message retention", [
    { note: "Messages in every channel and conversation in this workspace, including threads, files and reactions, are deleted once they are older than this. Deleted messages can't be brought back. Canvases, lists and bookmarks are kept." },
    { name: "days", label: "Keep messages for", type: "select", value: current, options: choices },
  ], "Save");
  if (!r || r.days === current) return;
  if (r.days && !confirm(`Delete every message older than ${choices.find(([v]) => v === r.days)[1].replace("Delete after ", "")}? This starts within a minute and can't be undone. Everyone will see a note in the default channel.`)) return;
  await api(T(`/workspaces/${w.id}/retention`), { method: "PUT", body: { days: r.days ? Number(r.days) : null } });
  await loadSidebar();
}

async function editPosting(c) {
  const r = await dialog(`Who can post in ${chanLabel(c)}`, [
    { name: "posting", label: "Who can start new messages", type: "select", value: c.posting || "everyone", options: [["everyone", "Everyone in the channel"], ["admins", "Only admins and the channel creator"]] },
    { name: "threadReplies", label: "When limited, everyone can still reply in threads", type: "checkbox", value: c.threadReplies !== false },
  ], "Save");
  if (!r) return;
  await api(T(`/channels/${c.id}`), { method: "PATCH", body: { posting: r.posting, threadReplies: r.threadReplies } });
  await refreshChannel();
}

async function refreshChannel() {
  if (!state.channel) return;
  const id = state.channel.id;
  state.channel = await api(T(`/channels/${id}`));
  const page = await api(T(`/channels/${id}/messages`));
  const stick = nearBottom();
  const older = state.messages.filter((m) => page.messages.length && m.createdAt < page.messages[0].createdAt);
  state.messages = [...older, ...page.messages];
  if (!older.length) state.hasMore = page.hasMore;
  renderHead();
  renderMessages(null, stick);
  if (state.channel.member && state.channel.unread > 0 && document.visibilityState === "visible") await api(T(`/channels/${id}/read`), { method: "POST", body: {} });
}

const nearBottom = () => { const s = $("#scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; };

function renderMessages(focusId, stick = true) {
  const list = $("#messages");
  const unreadAfter = state.channel.lastReadAt;
  list.replaceChildren();
  let lastDay = "";
  let prev = null;
  let markedNew = false;
  for (const m of state.messages) {
    const d = day(m.createdAt);
    if (d !== lastDay) { list.append(h("li", { class: "t-day" }, h("span", {}, d))); lastDay = d; prev = null; }
    if (!markedNew && unreadAfter && m.createdAt > unreadAfter && m.sender.sub !== state.me.sub) { list.append(h("li", { class: "t-new" }, h("span", {}, "New"))); markedNew = true; prev = null; }
    const compact = prev && prev.sender.sub === m.sender.sub && m.kind === "user" && prev.kind === "user" && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
    list.append(messageItem(m, { compact, focus: m.id === focusId }));
    prev = m;
  }
  if (state.messages.length === 0) list.append(h("li", { class: "meta t-first" }, "This is the very beginning. Say hello."));
  $("#older").hidden = !state.hasMore;
  const s = $("#scroll");
  if (focusId) list.querySelector(".focus")?.scrollIntoView({ block: "center" });
  else if (stick) s.scrollTop = s.scrollHeight;
}

function messageItem(m, { compact = false, focus = false, inThread = false } = {}) {
  if (m.kind === "system") return h("li", { class: "t-msg system" }, h("span", { class: "meta" }, `${m.sender.displayName} ${m.text} · ${time(m.createdAt)}`));
  const li = h("li", { class: `t-msg${compact ? " compact" : ""}${focus ? " focus" : ""}${m.mentions.includes(state.me.sub) ? " mentioned" : ""}${m.pinned ? " pinned" : ""}`, "data-id": m.id });
  if (!compact) li.append(h("div", { class: "t-who" }, m.app ? h("span", { class: "t-app", title: `Posted by an app for ${m.sender.displayName}` }, "APP") : dot(m.sender), h("button", { type: "button", class: "link strong", onclick: tryRun(() => showProfile(m.sender)) }, m.app ? m.app.name : personName(m.sender)), h("span", { class: "meta" }, time(m.createdAt)), m.pinned ? h("span", { class: "meta" }, "📌 pinned") : null));
  const body = h("div", { class: "t-body" });
  if (m.deleted) body.append(h("p", { class: "meta" }, "This message was deleted."));
  else if (m.unreadable) body.append(h("p", { class: "meta" }, "This message could not be read."));
  else if (state.editing === m.id) body.append(editBox(m));
  else if (m.poll) body.append(h("p", { class: "strong" }, "📊 ", ...inline(m.text)), pollBlock(m));
  else if (m.text) body.append(format(m.text));
  if (m.shared && !m.deleted) body.append(sharedBlock(m.shared));
  if (m.editedAt && !m.deleted) body.append(h("span", { class: "meta" }, " (edited)"));
  if (m.alsoInChannel && !inThread) body.prepend(h("p", { class: "meta" }, "replied to a thread"));
  for (const f of m.files) {
    const url = T(`/files/${f.id}`);
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) body.append(h("a", { href: url, class: "t-image" }, h("img", { src: `${url}?inline=1`, alt: f.name, loading: "lazy" })));
    if (/^audio\/(webm|ogg|mp4|mpeg)$/.test(f.mime)) {
      body.append(h("div", { class: "t-clip" }, h("span", { "aria-hidden": "true" }, "🎙"), h("audio", { controls: true, preload: "metadata", src: `${url}?inline=1`, "aria-label": f.name }), h("span", { class: "meta" }, f.name.replace(/\.[a-z0-9]+$/i, ""))));
      continue;
    }
    body.append(h("a", { href: url, class: "t-filecard", download: f.name }, `📎 ${f.name}`, h("span", { class: "meta" }, ` ${size(f.size)}`)));
  }
  li.append(body);
  if (m.reactions.length) li.append(h("div", { class: "t-reactions" }, ...m.reactions.map((r) => h("button", {
    type: "button", class: r.mine ? "mine" : "", "aria-pressed": String(r.mine), title: r.subs.length > 0 ? `${r.count} reacted` : "",
    onclick: tryRun(async () => { await api(T(`/messages/${m.id}/reactions`), { method: "POST", body: { emoji: r.emoji } }); await afterChange(m); }),
  }, emojiNode(r.emoji), ` ${r.count}`)), h("button", { type: "button", class: "add", "aria-label": "Add reaction", onclick: (e) => emojiPicker(e.currentTarget, async (emoji) => { await api(T(`/messages/${m.id}/reactions`), { method: "POST", body: { emoji, on: true } }); await afterChange(m); }) }, "+")));
  if (m.replyCount && !inThread) li.append(h("button", { type: "button", class: "t-replies link", onclick: tryRun(() => openThread(m.id)) }, `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}`, h("span", { class: "meta" }, ` · last ${when(m.lastReplyAt)}`)));
  if (!m.deleted && !m.unreadable) li.append(actions(m, inThread));
  return li;
}

function sharedBlock(s) {
  if (!s.available) return h("blockquote", { class: "t-shared" }, h("p", { class: "meta" }, "Shared from a conversation you can't see."));
  const where = s.channelKind === "dm" || s.channelKind === "group" ? "a conversation" : `#${s.channelName}`;
  return h("blockquote", { class: "t-shared" },
    h("div", { class: "t-who" }, dot(s.sender), h("span", { class: "strong" }, personName(s.sender)), h("span", { class: "meta" }, ` in ${where} · ${when(s.createdAt)}`)),
    format(s.text),
    ...s.files.map((f) => h("a", { href: T(`/files/${f.id}`), class: "t-filecard", download: f.name }, `📎 ${f.name}`, h("span", { class: "meta" }, ` ${size(f.size)}`))),
    h("button", { type: "button", class: "link meta", onclick: tryRun(() => jumpTo(s.id)) }, "View original"),
  );
}

async function shareMessage(m) {
  const targets = [...state.bar.channels.filter((c) => c.member && !c.archived), ...state.bar.direct];
  if (!targets.length) return;
  const r = await dialog("Share message", [
    { name: "channelId", label: "Share to", type: "select", options: targets.map((c) => [c.id, chanLabel(c)]), value: state.channel?.id },
    { name: "text", label: "Add a message (optional)", type: "textarea", rows: 3, max: 4000 },
  ], "Share");
  if (!r) return;
  const out = await api(T(`/messages/${m.id}/share`), { method: "POST", body: { channelId: r.channelId, text: r.text } });
  await openChannel(out.channelId);
}

function pollBlock(m) {
  const p = m.poll;
  const most = Math.max(1, ...p.options.map((o) => o.count));
  const mine = m.sender.sub === state.me.sub || ["owner", "admin"].includes(state.bar.workspace.role);
  return h("div", { class: "t-poll" },
    h("ol", { class: "t-poll-options" }, ...p.options.map((o, i) => {
      const bar = h("span", { class: "t-poll-bar" });
      bar.style.width = `${Math.round((o.count / most) * 100)}%`;
      return h("li", {},
        h("button", {
          type: "button", class: `t-poll-option${o.mine ? " mine" : ""}`, disabled: p.closed, "aria-pressed": String(o.mine),
          onclick: tryRun(async () => { await api(T(`/messages/${m.id}/vote`), { method: "POST", body: { choice: i } }); await afterChange(m); }),
        }, bar, h("span", { class: "t-poll-text" }, o.mine ? `✓ ${o.text}` : o.text), h("span", { class: "meta" }, String(o.count))),
        o.voters.length ? h("span", { class: "meta t-poll-voters" }, o.voters.join(", ")) : null);
    })),
    h("p", { class: "meta t-row" },
      `${p.voters} ${p.voters === 1 ? "person" : "people"} voted · ${p.multiple ? "pick any" : "pick one"}${p.anonymous ? " · anonymous" : ""}${p.closed ? " · closed" : ""}`,
      mine && !p.closed ? h("button", { type: "button", class: "link", onclick: tryRun(async () => { if (confirm("Close this poll? No one can vote after that.")) { await api(T(`/messages/${m.id}/close`), { method: "POST", body: {} }); await afterChange(m); } }) }, "Close poll") : null),
  );
}

async function newPoll() {
  const r = await dialog("Create a poll", [
    { name: "question", label: "Question", max: 300, required: true },
    { name: "options", label: "Options, one per line (2 to 10)", type: "textarea", rows: 5, max: 1300 },
    { name: "multiple", label: "People can pick more than one", type: "checkbox" },
    { name: "anonymous", label: "Anonymous: hide who voted", type: "checkbox" },
  ], "Post poll");
  if (!r) return;
  await api(T(`/channels/${state.channel.id}/polls`), { method: "POST", body: { question: r.question, options: r.options.split(/\r?\n/).map((o) => o.trim()).filter(Boolean), multiple: r.multiple, anonymous: r.anonymous } });
  await refreshChannel();
}

function actions(m, inThread) {
  const mine = m.sender.sub === state.me.sub;
  const admin = ["owner", "admin"].includes(state.bar.workspace.role);
  return h("div", { class: "t-actions" },
    h("button", { type: "button", title: "React", "aria-label": "React", onclick: (e) => emojiPicker(e.currentTarget, async (emoji) => { await api(T(`/messages/${m.id}/reactions`), { method: "POST", body: { emoji, on: true } }); await afterChange(m); }) }, "☺"),
    !inThread ? h("button", { type: "button", title: "Reply in thread", "aria-label": "Reply in thread", onclick: tryRun(() => openThread(m.id)) }, "↩") : null,
    h("button", { type: "button", title: m.saved ? "Remove from Later" : "Save for later", "aria-label": "Save for later", onclick: tryRun(async () => { await api(T(`/messages/${m.id}/save`), { method: "PUT", body: { saved: !m.saved } }); await afterChange(m); await loadSidebar(); }) }, m.saved ? "★" : "☆"),
    h("button", { type: "button", title: "More", "aria-label": "More actions", onclick: (e) => menu(e.currentTarget, [
      [m.pinned ? "Unpin" : "Pin to channel", async () => { await api(T(`/messages/${m.id}/pin`), { method: "PUT", body: { pinned: !m.pinned } }); await afterChange(m); }],
      ["Remind me about this", async () => {
        const r = await dialog("Remind me", [{ name: "in", label: "When", type: "select", options: [["20", "In 20 minutes"], ["60", "In 1 hour"], ["180", "In 3 hours"], ["1440", "Tomorrow"], ["10080", "Next week"]] }]);
        if (r) { await api(T(`/messages/${m.id}/save`), { method: "PUT", body: { remindAt: new Date(Date.now() + Number(r.in) * 60_000).toISOString() } }); await afterChange(m); await loadSidebar(); }
      }],
      m.kind !== "system" && ["Share message…", () => shareMessage(m)],
      ["Mark unread", async () => { await api(T(`/channels/${m.channelId}/read`), { method: "POST", body: { unreadFrom: m.id } }); await loadSidebar(); }],
      ["Copy link", async () => { await navigator.clipboard.writeText(messageLink(m.id)); showNote("Link copied. Anyone who can see this message can open it."); }],
      mine && ["Edit message", () => { state.editing = m.id; inThread ? renderThread() : renderMessages(null, false); }],
      (mine || admin) && ["Delete message", async () => { if (confirm("Delete this message? This cannot be undone.")) { await api(T(`/messages/${m.id}`), { method: "DELETE" }); await afterChange(m); } }],
    ]) }, "⋯"),
  );
}

function editBox(m) {
  const ta = h("textarea", { class: "input", rows: 3, maxlength: 4000 });
  ta.value = m.text;
  const save = tryRun(async () => { await api(T(`/messages/${m.id}`), { method: "PATCH", body: { text: ta.value } }); state.editing = null; await afterChange(m); });
  const cancel = () => { state.editing = null; afterChange(m); };
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === "Escape") cancel(); });
  setTimeout(() => ta.focus(), 0);
  return h("div", { class: "t-edit" }, ta, h("p", { class: "t-row" }, h("button", { type: "button", class: "btn small", onclick: cancel }, "Cancel"), h("button", { type: "button", class: "btn primary small", onclick: save }, "Save")));
}

async function afterChange(m) {
  if (state.channel && m.channelId === state.channel.id) await refreshChannel();
  if (state.thread) await openThread(state.thread.parent.id, true);
  if (state.view) await showView(state.view);
}

// ---------- composer ----------

const draftKey = () => `team.draft.${state.channel?.id}`;
// Drafts are kept in this browser and, once you type, on the server too, so they follow you to your other devices.
let draftTimer = 0;
let draftDirty = false;
let serverDrafts = null; // channel id → text, loaded on demand
function saveDraft() {
  if (!state.channel) return;
  const v = $("#text").value;
  try { v ? localStorage.setItem(draftKey(), v) : localStorage.removeItem(draftKey()); } catch {}
  syncDraft();
}
function syncDraft() {
  clearTimeout(draftTimer);
  if (!draftDirty || !state.channel?.member || state.channel.archived) return;
  draftDirty = false;
  const id = state.channel.id;
  const text = $("#text").value;
  if (serverDrafts) text.trim() ? serverDrafts.set(id, text) : serverDrafts.delete(id);
  api(T(`/channels/${id}/draft`), { method: "PUT", body: { text } }).catch(() => { draftDirty = true; });
}
async function loadDrafts() {
  if (serverDrafts?.ws !== state.wsId) serverDrafts = null;
  if (!serverDrafts) serverDrafts = Object.assign(new Map((await api(T(`/workspaces/${state.wsId}/drafts`))).drafts.map((d) => [d.channel.id, d.text])), { ws: state.wsId });
  return serverDrafts;
}
function restoreDraft() {
  if (typeof stopClip === "function") stopClip(true);
  draftDirty = false;
  let local = "";
  try { local = localStorage.getItem(draftKey()) || ""; } catch {}
  $("#text").value = local;
  state.files = [];
  renderAttachments();
  const id = state.channel?.id;
  if (!id || !state.bar?.drafts) return;
  loadDrafts().then((drafts) => {
    // Fill in a draft from another device, unless you have started typing here.
    if (state.channel?.id === id && !draftDirty && drafts.has(id) && $("#text").value === local) $("#text").value = drafts.get(id);
  }).catch(() => {});
}
function forgetDraft() {
  draftDirty = false;
  clearTimeout(draftTimer);
  try { localStorage.removeItem(draftKey()); } catch {}
  if (serverDrafts && state.channel) serverDrafts.delete(state.channel.id);
}

function renderAttachments() {
  $("#attachments").replaceChildren(...state.files.map((f) => h("span", { class: "t-chip" }, `${f.mime?.startsWith("audio/") ? "🎙" : "📎"} ${f.name}`, h("button", { type: "button", class: "link", "aria-label": `Remove ${f.name}`, onclick: () => { state.files = state.files.filter((x) => x !== f); renderAttachments(); } }, "×"))));
}

async function upload(file, channelId) {
  if (file.size > 1_000_000) throw new Error("Files can be up to 1 MB");
  const data = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read the file"));
    r.readAsDataURL(file);
  });
  return api(T(`/channels/${channelId}/files`), { method: "POST", body: { name: file.name, mime: file.type || "application/octet-stream", data } });
}

async function send(text, parentId = null, alsoInChannel = false, fileIds = [], channelId = state.channel?.id) {
  if (!channelId) throw new Error("Open a channel first");
  const out = await api(T(`/channels/${channelId}/messages`), { method: "POST", body: { text, parentId, alsoInChannel, fileIds, tzOffset: -new Date().getTimezoneOffset() } });
  if (out.ephemeral) showNote(out.ephemeral);
  if (out.notInChannel?.length) showNote(`${out.notInChannel.map((n) => `@${n}`).join(", ")} ${out.notInChannel.length === 1 ? "is" : "are"} not in this channel and won't be notified. Use /invite to add them.`);
  if (out.channelId && out.channelId !== state.channel?.id) await openChannel(out.channelId);
  return out;
}

function showNote(text) {
  const li = h("li", { class: "t-msg ephemeral" }, h("p", { class: "meta" }, "Only visible to you"), format(text));
  $("#messages").append(li);
  $("#scroll").scrollTop = $("#scroll").scrollHeight;
}

$("#composer").addEventListener("submit", tryRun(async (e) => {
  e.preventDefault();
  const text = $("#text").value;
  if (!text.trim() && state.files.length === 0) return;
  const files = state.files;
  $("#send").disabled = true;
  $("#text").value = "";
  state.files = [];
  renderAttachments();
  try {
    await send(text, null, false, files.map((f) => f.id));
    forgetDraft();
  } catch (error) {
    // Put the message back so nothing is lost.
    if (!$("#text").value) $("#text").value = text;
    state.files = files;
    renderAttachments();
    throw error;
  } finally {
    $("#send").disabled = false;
  }
  if (state.channel) await refreshChannel();
  await loadSidebar();
}));

let typingSent = 0;
function bindComposer(ta, submit, parentId) {
  ta.addEventListener("keydown", (e) => {
    const box = $("#suggest");
    if (!box.hidden && box.dataset.for === ta.id && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) {
      const items = [...box.children];
      let i = items.findIndex((x) => x.classList.contains("on"));
      if (e.key === "Escape") { box.hidden = true; e.stopPropagation(); return; }
      e.preventDefault();
      if (e.key === "ArrowDown") i = (i + 1) % items.length;
      else if (e.key === "ArrowUp") i = (i - 1 + items.length) % items.length;
      else { items[Math.max(0, i)]?.click(); return; }
      items.forEach((x, j) => x.classList.toggle("on", j === i));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#suggest").hidden = true; submit(); }
    if (e.key === "ArrowUp" && !ta.value) {
      const mine = [...(parentId ? state.thread?.replies || [] : state.messages)].reverse().find((m) => m.sender.sub === state.me.sub && m.kind === "user" && !m.deleted);
      if (mine) { e.preventDefault(); state.editing = mine.id; parentId ? renderThread() : renderMessages(null, false); }
    }
  });
  ta.addEventListener("blur", () => setTimeout(() => { const box = $("#suggest"); if (box.dataset.for === ta.id && !box.matches(":hover")) box.hidden = true; }, 150));
  ta.addEventListener("input", () => {
    suggest(ta);
    if (Date.now() - typingSent > 3000 && ta.value.trim() && !ta.value.startsWith("/")) {
      typingSent = Date.now();
      const channelId = parentId ? state.thread?.parent.channelId : state.channel?.id;
      if (channelId) api(T(`/channels/${channelId}/typing`), { method: "POST", body: { parentId } }).catch(() => {});
    }
  });
}

const COMMANDS = ["/me", "/shrug", "/topic", "/purpose", "/rename", "/invite", "/kick", "/join", "/leave", "/archive", "/dm", "/remind me to ", "/status", "/away", "/active", "/dnd", "/mute", "/unmute", "/who", "/poll ", "/help"];
let peopleCache = { at: 0, list: [] };
async function suggest(ta) {
  const box = $("#suggest");
  const upto = ta.value.slice(0, ta.selectionStart);
  const at = /(^|\s)@([a-z0-9._-]*)$/i.exec(upto);
  const hash = /(^|\s)#([a-z0-9_-]*)$/i.exec(upto);
  const slash = /^\/([a-z]*)$/i.exec(upto);
  let items = [];
  if (at) {
    if (Date.now() - peopleCache.at > 30_000) peopleCache = { at: Date.now(), list: (await api(T(`/workspaces/${state.wsId}/people`))).people.filter((p) => !p.deactivated) };
    const q = at[2].toLowerCase();
    const groups = q.length >= 0 ? (await api(T(`/workspaces/${state.wsId}/groups`))).groups : [];
    items = [
      ...["here", "channel"].filter((s) => s.startsWith(q)).map((s) => [`@${s}`, s === "here" ? "Notify active members" : "Notify everyone in the channel", `@${s} `]),
      ...peopleCache.list.filter((p) => p.username.startsWith(q) || p.displayName.toLowerCase().startsWith(q)).map((p) => [`@${p.username}`, p.displayName, `@${p.username} `]),
      ...groups.filter((g) => g.handle.startsWith(q)).map((g) => [`@${g.handle}`, `${g.name} · ${g.members.length} people`, `@${g.handle} `]),
    ].slice(0, 8);
    items = items.map(([a, b, ins]) => [a, b, ins, at[2].length]);
  } else if (hash) {
    const q = hash[2].toLowerCase();
    items = state.bar.channels.filter((c) => c.name.startsWith(q)).slice(0, 8).map((c) => [`#${c.name}`, c.topic, `#${c.name} `, q.length]);
  } else if (slash) {
    items = COMMANDS.filter((c) => c.startsWith(`/${slash[1]}`)).slice(0, 8).map((c) => [c.trim(), "", `${c.trim()} `, slash[1].length + 1]);
  }
  if (!items.length) { box.hidden = true; return; }
  box.dataset.for = ta.id;
  if (box.parentElement !== ta.parentElement) ta.parentElement.append(box);
  box.replaceChildren(...items.map(([a, b, ins, back], i) => h("li", { class: i === 0 ? "on" : "", onclick: () => {
    const pos = ta.selectionStart;
    const start = pos - back - (slash ? 0 : 1);
    ta.value = ta.value.slice(0, start) + ins + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = start + ins.length;
    box.hidden = true;
    ta.focus();
  } }, h("strong", {}, a), b ? h("span", { class: "meta" }, ` ${b}`) : null)));
  box.hidden = false;
}

bindComposer($("#text"), () => $("#composer").requestSubmit(), null);
$("#text").addEventListener("input", () => { draftDirty = true; clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 1500); });
window.addEventListener("pagehide", saveDraft);

$("#file").addEventListener("change", tryRun(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.channel) return;
  state.files.push(await upload(file, state.channel.id));
  renderAttachments();
}));

$("#poll").addEventListener("click", tryRun(newPoll));

// ---------- voice clips ----------
// Record a short audio message in the browser and attach it like a file. Up to three minutes, small enough
// (Opus at 32 kbit/s) to fit the 1 MB file limit.

const CLIP_SECONDS = 180;
const clipType = () => ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
let clip = null;

async function startClip() {
  if (clip || !state.channel) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("This browser can't record audio");
  const type = clipType();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32_000 });
  const chunks = [];
  const channelId = state.channel.id;
  const started = Date.now();
  clip = { recorder, stream, cancelled: false, timer: 0 };
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = tryRun(async () => {
    const { cancelled } = clip;
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(clip.timer);
    clip = null;
    renderClip();
    if (cancelled) return;
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    const mime = (recorder.mimeType || type || "audio/webm").split(";")[0];
    const ext = mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm";
    const file = new File(chunks, `Voice clip ${mmss(seconds)}.${ext}`, { type: mime });
    if (file.size > 1_000_000) throw new Error("That clip is too long to send");
    state.files.push(await upload(file, channelId));
    renderAttachments();
    $("#text").focus();
  });
  recorder.start(1000);
  clip.timer = setInterval(() => { renderClip(Math.round((Date.now() - started) / 1000)); if (Date.now() - started >= CLIP_SECONDS * 1000) stopClip(false); }, 250);
  renderClip(0);
}

function stopClip(cancel) {
  if (!clip) return;
  clip.cancelled = cancel;
  if (clip.recorder.state !== "inactive") clip.recorder.stop();
}

function renderClip(seconds = 0) {
  const bar = $("#clip-status");
  if (!clip) { bar.hidden = true; bar.replaceChildren(); $("#record").hidden = false; return; }
  $("#record").hidden = true;
  bar.hidden = false;
  bar.replaceChildren(
    h("span", { class: "t-rec-dot", "aria-hidden": "true" }), h("span", { role: "timer" }, `Recording ${mmss(seconds)} / ${mmss(CLIP_SECONDS)}`),
    h("button", { type: "button", class: "btn primary small", onclick: () => stopClip(false) }, "Done"),
    h("button", { type: "button", class: "btn small", onclick: () => stopClip(true) }, "Cancel"));
}

$("#record").addEventListener("click", tryRun(startClip));
$("#schedule").addEventListener("click", tryRun(async () => {
  const text = $("#text").value;
  if (!text.trim()) throw new Error("Write the message first");
  const soon = new Date(Date.now() + 60 * 60_000);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const r = await dialog("Schedule message", [{ name: "at", label: "Send at", type: "datetime-local", value: local, required: true }], "Schedule");
  if (!r) return;
  await api(T(`/channels/${state.channel.id}/schedule`), { method: "POST", body: { text, sendAt: new Date(r.at).toISOString() } });
  $("#text").value = "";
  forgetDraft();
  await api(T(`/channels/${state.channel.id}/draft`), { method: "PUT", body: { text: "" } }).catch(() => {});
  showNote(`Scheduled for ${when(new Date(r.at).toISOString())}.`);
  await loadSidebar();
}));

$("#older").addEventListener("click", tryRun(async () => {
  const s = $("#scroll");
  const before = s.scrollHeight;
  const page = await api(T(`/channels/${state.channel.id}/messages?before=${encodeURIComponent(state.messages[0].createdAt)}`));
  state.messages = [...page.messages, ...state.messages];
  state.hasMore = page.hasMore;
  renderMessages(null, false);
  s.scrollTop = s.scrollHeight - before;
}));

// ---------- side panel ----------

function panel(title, ...content) {
  state.listChannel = null;
  $("#panel").hidden = false;
  $("#panel-title").textContent = title;
  $("#panel-body").replaceChildren(...content.filter((c) => c !== null && c !== undefined && c !== false));
}
$("#panel-close").addEventListener("click", () => { $("#panel").hidden = true; state.thread = null; state.listChannel = null; });

// ---------- task lists ----------

const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const dueLabel = (due) => {
  if (!due) return null;
  const t = today();
  const text = due === t ? "Today" : new Date(`${due}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  return h("span", { class: `t-due${due < t ? " late" : due === t ? " soon" : ""}`, title: due < t ? "Overdue" : "Due" }, `📅 ${text}`);
};

function taskItem(task, { showChannel = false, onChange }) {
  const box = h("input", { type: "checkbox", "aria-label": task.done ? "Mark as not done" : "Mark as done" });
  box.checked = task.done;
  box.addEventListener("change", tryRun(async () => { await api(T(`/tasks/${task.id}`), { method: "PATCH", body: { done: box.checked } }); await onChange(); }));
  return h("li", { class: `t-task${task.done ? " done" : ""}` },
    box,
    h("div", { class: "t-task-body" },
      h("span", { class: "t-task-title" }, ...inline(task.title)),
      task.notes ? h("p", { class: "meta t-task-notes" }, task.notes) : null,
      h("p", { class: "t-row meta" },
        showChannel ? h("button", { type: "button", class: "link meta", onclick: tryRun(() => showList(task.channelId)) }, chanName(task.channelId)) : null,
        task.assignee ? h("span", {}, `@${task.assignee.username}`) : null,
        task.done ? null : dueLabel(task.due),
        task.done && task.doneBy ? h("span", {}, `done by ${task.doneBy.displayName}`) : null)),
    h("button", { type: "button", class: "link", "aria-label": "Task options", onclick: (e) => menu(e.currentTarget, [
      ["Edit task", () => editTask(task, onChange)],
      ["Remove task", async () => { if (confirm(`Remove “${task.title}”?`)) { await api(T(`/tasks/${task.id}`), { method: "DELETE" }); await onChange(); } }],
    ]) }, "⋯"));
}

async function taskFields(channelId, task) {
  const { people } = await api(T(`/channels/${channelId}/people`));
  return [
    { name: "title", label: "Task", value: task?.title, max: 300, required: true },
    { name: "assignee", label: "Assignee", type: "select", value: task?.assignee?.username || "", options: [["", "Nobody"], ...people.map((p) => [p.username, `${p.displayName} (@${p.username})`])] },
    { name: "due", label: "Due date", type: "date", value: task?.due || "" },
    { name: "notes", label: "Notes", type: "textarea", rows: 3, max: 4000, value: task?.notes || "" },
  ];
}

async function editTask(task, onChange) {
  const r = await dialog("Edit task", await taskFields(task.channelId, task), "Save");
  if (!r) return;
  await api(T(`/tasks/${task.id}`), { method: "PATCH", body: { title: r.title, assignee: r.assignee || null, due: r.due || null, notes: r.notes } });
  await onChange();
}

async function showList(channelId = state.channel?.id) {
  if (!channelId) return;
  const { tasks } = await api(T(`/channels/${channelId}/tasks`));
  state.thread = null;
  const c = [...state.bar.channels, ...state.bar.direct].find((x) => x.id === channelId) || state.channel;
  const canEdit = c && c.member !== false && !c.archived;
  const refresh = async () => { await showList(channelId); if (state.channel?.id === channelId) await refreshChannel(); await loadSidebar(); };
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const title = h("input", { class: "input", maxlength: 300, placeholder: "Add a task", "aria-label": "New task" });
  const add = h("form", { class: "t-task-add", onsubmit: tryRun(async (e) => {
    e.preventDefault();
    if (!title.value.trim()) return;
    await api(T(`/channels/${channelId}/tasks`), { method: "POST", body: { title: title.value } });
    await refresh();
    document.querySelector(".t-task-add input")?.focus();
  }) }, title, h("button", { type: "submit", class: "btn small" }, "Add"),
    h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
      const r = await dialog("New task", await taskFields(channelId, null), "Add");
      if (r) { await api(T(`/channels/${channelId}/tasks`), { method: "POST", body: { title: r.title, assignee: r.assignee || null, due: r.due || null, notes: r.notes } }); await refresh(); }
    }) }, "More…"));
  panel(`List · ${c ? chanLabel(c) : "channel"}`,
    canEdit ? add : null,
    open.length ? h("ul", { class: "t-tasks" }, ...open.map((t) => taskItem(t, { onChange: refresh }))) : h("p", { class: "meta" }, "A shared to-do list for this channel. Add tasks, assign them and set due dates."),
    done.length ? h("details", {}, h("summary", { class: "meta" }, `${done.length} done`), h("ul", { class: "t-tasks" }, ...done.map((t) => taskItem(t, { onChange: refresh })))) : null);
  state.listChannel = channelId;
}

async function openThread(id, keepScroll = false) {
  state.thread = await api(T(`/messages/${id}/thread`));
  renderThread(keepScroll);
}

function renderThread(keepScroll = false) {
  const t = state.thread;
  const ta = h("textarea", { id: "thread-text", class: "input", rows: 2, maxlength: 4000, placeholder: "Reply…" });
  const also = h("input", { type: "checkbox", id: "thread-also" });
  const submit = tryRun(async () => {
    const text = ta.value;
    if (!text.trim()) return;
    ta.value = "";
    try {
      await send(text, t.parent.id, also.checked, [], t.parent.channelId);
    } catch (error) {
      if (!ta.value) ta.value = text;
      throw error;
    }
    await openThread(t.parent.id);
    if (also.checked) await refreshChannel();
  });
  const list = h("ol", { class: "t-messages" }, messageItem(t.parent, { inThread: true }), h("li", { class: "t-day" }, h("span", {}, `${t.replies.length} ${t.replies.length === 1 ? "reply" : "replies"}`)), ...t.replies.map((m) => messageItem(m, { inThread: true })));
  const canReply = t.channel.canReply !== false;
  panel(`Thread in ${chanLabel(t.channel)}`, list, canReply ? h("form", { class: "t-composer", onsubmit: (e) => { e.preventDefault(); submit(); } }, ta,
    h("div", { class: "t-composer-bar" }, t.channel.canPost !== false ? h("label", { for: "thread-also", class: "meta" }, also, ` Also send to ${chanLabel(t.channel)}`) : h("span"), h("button", { class: "btn primary small", type: "submit" }, "Reply")))
    : h("p", { class: "meta" }, t.channel.member === false ? "Join the channel to reply." : "Only admins and the channel creator can reply here."));
  bindComposer(ta, submit, t.parent.id);
  const body = $("#panel-body");
  if (!keepScroll) { body.scrollTop = body.scrollHeight; ta.focus(); }
}

async function showMembers() {
  const c = state.channel;
  const { people } = await api(T(`/channels/${c.id}/people`));
  state.thread = null;
  panel(`Members of ${chanLabel(c)}`, h("ul", { class: "t-people" }, ...people.map((p) => personRow(p, c.kind === "public" || c.kind === "private" ? [["Remove from channel", async () => { await api(T(`/channels/${c.id}/kick`), { method: "POST", body: { username: p.username } }); await showMembers(); await refreshChannel(); }]] : []))));
}

function personRow(p, extra = []) {
  return h("li", {}, dot(p), h("button", { type: "button", class: "link", onclick: tryRun(() => showProfile(p)) }, personName(p)), h("span", { class: "meta" }, ` @${p.username}${p.title ? ` · ${p.title}` : ""}${p.role !== "member" ? ` · ${p.role}` : ""}${p.deactivated ? " · deactivated" : ""}`),
    extra.length ? h("button", { type: "button", class: "link", "aria-label": `More for ${p.username}`, onclick: (e) => menu(e.currentTarget, extra) }, " ⋯") : null);
}

async function showProfile(p) {
  state.thread = null;
  const isMe = p.sub === state.me.sub;
  const admin = state.bar.workspace.role === "owner";
  panel(p.displayName,
    h("p", {}, dot(p), ` ${p.presence === "active" ? "Active" : "Away"}${p.dnd ? ` · ${p.quietHours ? "Outside working hours, notifications" : "Do not disturb"} until ${time(p.dndUntil)}` : ""}`),
    h("p", {}, `@${p.username}`), p.title ? h("p", {}, p.title) : null,
    p.statusEmoji || p.statusText ? h("p", {}, `${p.statusEmoji || ""} ${p.statusText || ""}${p.statusUntil ? ` · until ${when(p.statusUntil)}` : ""}`) : null,
    h("p", { class: "t-row" },
      !isMe ? h("button", { type: "button", class: "btn primary small", onclick: tryRun(async () => { const c = await api(T(`/workspaces/${state.wsId}/conversations`), { method: "POST", body: { people: [p.username] } }); await openChannel(c.id); }) }, "Message") : null,
      isMe ? h("button", { type: "button", class: "btn small", onclick: tryRun(editProfile) }, "Edit profile") : null,
      admin && !isMe ? h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
        const r = await dialog(`Role for @${p.username}`, [{ name: "role", label: "Role", type: "select", options: [["member", "Member"], ["admin", "Admin"], ["owner", "Owner"], ["guest", "Guest"]], value: p.role }]);
        if (r) { await api(T(`/workspaces/${state.wsId}/people/${p.username}/role`), { method: "PUT", body: r }); await showView("people"); }
      }) }, "Change role") : null,
      ["owner", "admin"].includes(state.bar.workspace.role) && !isMe && p.role !== "owner" && !p.deactivated ? h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
        if (confirm(`Remove @${p.username} from this workspace?`)) { await api(T(`/workspaces/${state.wsId}/people/${p.username}`), { method: "DELETE" }); await showView("people"); }
      }) }, "Remove from workspace") : null,
    ),
  );
}

async function editProfile() {
  const me = state.bar.me;
  const r = await dialog("Edit profile", [{ name: "displayName", label: "Display name", value: me.displayName, max: 80 }, { name: "title", label: "Title", value: me.title || "", max: 100 }], "Save");
  if (r) { await api(T(`/workspaces/${state.wsId}/me`), { method: "PATCH", body: r }); peopleCache.at = 0; await loadSidebar(); }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function workflowWhen(w) {
  if (w.kind === "welcome") return "Sent to each person who joins";
  const at = w.at;
  return `${w.every === "day" ? "Every day" : w.every === "weekday" ? "Every weekday" : `Every ${WEEKDAYS[w.weekday]}`} at ${at}`;
}

async function showWorkflows() {
  const c = state.channel;
  const { workflows } = await api(T(`/channels/${c.id}/workflows`));
  const admin = ["owner", "admin"].includes(state.bar.workspace.role);
  state.thread = null;
  panel("Workflows",
    h("p", { class: "meta" }, `Welcome people who join ${chanLabel(c)}, or post the same message on a schedule. Workflow messages show the workflow's name.`),
    workflows.length ? h("ul", { class: "t-files" }, ...workflows.map((w) => h("li", {},
      h("span", { class: "strong" }, w.name), " ",
      h("span", { class: "meta" }, `${workflowWhen(w)}${w.paused ? " · paused" : w.nextRunAt ? ` · next ${when(w.nextRunAt)}` : ""} · by ${w.createdBy.displayName}`),
      h("p", { class: "t-workflow-text" }, w.text),
      w.createdBy.sub === state.me.sub || admin ? h("span", { class: "t-row" },
        h("button", { type: "button", class: "link", onclick: tryRun(async () => { await api(T(`/workflows/${w.id}`), { method: "PATCH", body: { paused: !w.paused } }); await showWorkflows(); }) }, w.paused ? "Resume" : "Pause"),
        h("button", { type: "button", class: "link", onclick: tryRun(async () => { if (confirm(`Remove the workflow “${w.name}”?`)) { await api(T(`/workflows/${w.id}`), { method: "DELETE" }); await showWorkflows(); } }) }, "Remove")) : null)))
      : h("p", { class: "meta" }, "No workflows here yet."),
    c.member && !c.archived && state.bar.workspace.role !== "guest" ? h("p", { class: "t-row" },
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
        const r = await dialog("Welcome message", [
          { name: "name", label: "Name", value: "Welcome", max: 60, required: true },
          { name: "text", label: "Message sent to each person who joins. {name} becomes their name.", type: "textarea", rows: 5, max: 4000 },
        ], "Add");
        if (r) { await api(T(`/channels/${c.id}/workflows`), { method: "POST", body: { kind: "welcome", name: r.name, text: r.text } }); await showWorkflows(); }
      }) }, "Add welcome message"),
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
        const r = await dialog("Recurring message", [
          { name: "name", label: "Name", value: "Standup", max: 60, required: true },
          { name: "text", label: "Message", type: "textarea", rows: 4, max: 4000 },
          { name: "every", label: "Repeat", type: "select", options: [["weekday", "Every weekday"], ["day", "Every day"], ["week", "Once a week"]] },
          { name: "weekday", label: "Day (for once a week)", type: "select", options: WEEKDAYS.map((d, i) => [String(i), d]) },
          { name: "at", label: "Time", type: "time", value: "09:30", required: true },
        ], "Add");
        if (r) {
          await api(T(`/channels/${c.id}/workflows`), { method: "POST", body: { kind: "recurring", name: r.name, text: r.text, every: r.every, weekday: Number(r.weekday), at: r.at, tzOffset: -new Date().getTimezoneOffset() } });
          await showWorkflows();
        }
      }) }, "Add recurring message")) : null,
  );
}

async function showWebhooks(created) {
  const c = state.channel;
  const { webhooks } = await api(T(`/workspaces/${state.wsId}/webhooks`));
  const here = webhooks.filter((w) => w.channel.id === c.id);
  state.thread = null;
  panel("Incoming webhooks",
    h("p", { class: "meta" }, `Other services can post to ${chanLabel(c)} by sending JSON like {"text": "Build passed"} to a webhook URL. Messages show the webhook's name and are posted on behalf of the person who added it.`),
    created ? h("div", { class: "t-secret" },
      h("p", { class: "strong" }, `Copy the URL for “${created.name}” now. It is shown only once.`),
      h("input", { class: "input", readonly: true, value: `${location.origin}${created.path}`, onfocus: (e) => e.target.select() }),
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await navigator.clipboard.writeText(`${location.origin}${created.path}`); showNote("Copied."); }) }, "Copy URL")) : null,
    here.length ? h("ul", { class: "t-files" }, ...here.map((w) => h("li", {},
      h("span", { class: "strong" }, w.name), " ",
      h("span", { class: "meta" }, `added by ${w.createdBy.displayName} · ${w.lastUsedAt ? `last used ${when(w.lastUsedAt)}` : "never used"}`), " ",
      h("button", { type: "button", class: "link", onclick: tryRun(async () => { if (confirm(`Remove the webhook “${w.name}”? Anything still sending to it will get an error.`)) { await api(T(`/webhooks/${w.id}`), { method: "DELETE" }); await showWebhooks(); } }) }, "Remove"))))
      : h("p", { class: "meta" }, "No webhooks post here yet."),
    c.member && !c.archived && state.bar.workspace.role !== "guest" ? h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
      const r = await dialog("Add an incoming webhook", [{ name: "name", label: "Name shown on its messages", max: 60, required: true, placeholder: "CI, Deploys, Alerts…" }], "Add");
      if (r) await showWebhooks(await api(T(`/channels/${c.id}/webhooks`), { method: "POST", body: { name: r.name } }));
    }) }, "Add incoming webhook") : null,
  );
}

async function showPins() {
  const { messages } = await api(T(`/channels/${state.channel.id}/pins`));
  state.thread = null;
  panel("Pinned", messages.length ? h("ol", { class: "t-messages" }, ...messages.map((m) => messageItem(m, { inThread: true }))) : h("p", { class: "meta" }, "Nothing is pinned yet. Use ⋯ → Pin to channel on a message."));
}

async function showCanvas() {
  const c = state.channel;
  const canvas = await api(T(`/channels/${c.id}/canvas`));
  state.thread = null;
  const ta = h("textarea", { class: "input t-canvas", rows: 18, maxlength: 50000 });
  ta.value = canvas.text;
  const view = h("div", { class: "t-canvas-view" }, canvas.text ? format(canvas.text) : h("p", { class: "meta" }, "A canvas is a shared document for this channel: notes, decisions, links, checklists."));
  const editing = h("div", { hidden: true }, ta, h("p", { class: "t-row" }, h("button", { type: "button", class: "btn primary small", onclick: tryRun(async () => { await api(T(`/channels/${c.id}/canvas`), { method: "PUT", body: { text: ta.value } }); await showCanvas(); await refreshChannel(); }) }, "Save")));
  panel(`Canvas · ${chanLabel(c)}`, view, editing,
    canvas.updatedAt ? h("p", { class: "meta" }, `Edited by ${canvas.updatedBy.displayName}, ${when(canvas.updatedAt)}`) : null,
    c.member && !c.archived ? h("button", { type: "button", class: "btn small", onclick: () => { view.hidden = true; editing.hidden = false; ta.focus(); } }, "Edit") : null);
}

async function showFiles(channelId) {
  const { files } = await api(T(`/workspaces/${state.wsId}/files${channelId ? `?channel=${channelId}` : ""}`));
  const list = h("ul", { class: "t-files" }, ...files.map((f) => h("li", {}, h("a", { href: T(`/files/${f.id}`), download: f.name }, `📎 ${f.name}`), h("span", { class: "meta" }, ` ${size(f.size)} · ${when(f.createdAt)}`))));
  if (channelId) panel("Files", files.length ? list : h("p", { class: "meta" }, "No files shared here yet."));
  return files.length ? list : h("p", { class: "meta" }, "No files yet.");
}

async function addBookmark() {
  const r = await dialog("Add a bookmark", [{ name: "url", label: "Link", type: "url", required: true, max: 2000 }, { name: "title", label: "Name", max: 120 }], "Add");
  if (r) { await api(T(`/channels/${state.channel.id}/bookmarks`), { method: "POST", body: r }); await refreshChannel(); }
}

// ---------- views ----------

function viewShell(title, ...content) {
  saveDraft();
  state.channel = null;
  $("#composer").hidden = true;
  $("#bookmarks").replaceChildren();
  $("#head").replaceChildren(h("div", { class: "t-title" }, h("h2", {}, title)));
  $("#older").hidden = true;
  $("#messages").replaceChildren(...content.flat().filter(Boolean));
  $("#scroll").scrollTop = 0;
  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-current", b.dataset.view === state.view ? "true" : "false"));
  document.querySelectorAll(".t-list [aria-current]").forEach((b) => b.removeAttribute("aria-current"));
}

const card = (m, extra) => h("li", { class: "t-card" },
  h("button", { type: "button", class: "link meta", onclick: tryRun(() => jumpTo(m.id)) }, `${state.bar ? chanName(m.channelId) : ""} · ${when(m.createdAt)}`),
  messageItem(m, { inThread: true }), extra || null);
const chanName = (id) => { const c = [...state.bar.channels, ...state.bar.direct].find((x) => x.id === id); return c ? chanLabel(c) : "a channel"; };

async function showView(view) {
  state.view = view;
  setRoute(`#/v/${view}`);
  const ws = state.wsId;
  if (view === "activity") {
    const { items } = await api(T(`/workspaces/${ws}/activity`));
    if (items[0]) { state.lastActivitySeen = items[0].at; try { localStorage.setItem("team.activity", items[0].at); } catch {} $("#badge-activity").hidden = true; }
    const verb = { mention: "mentioned you", reply: "replied to a thread", reaction: "reacted", reminder: "Reminder" };
    viewShell("Activity", items.length ? items.map((i) => h("li", { class: "t-card" }, h("p", { class: "meta" }, i.kind === "reminder" ? "⏰ Reminder" : `${i.actor.displayName} ${verb[i.kind]}${i.emoji ? ` ${i.emoji}` : ""} · ${when(i.at)}`),
      h("button", { type: "button", class: "link", onclick: tryRun(() => jumpTo(i.message.id)) }, chanName(i.message.channelId)), messageItem(i.message, { inThread: true }))) : h("li", { class: "meta" }, "Mentions, replies and reactions to your messages show up here."));
  } else if (view === "threads") {
    const { threads } = await api(T(`/workspaces/${ws}/threads`));
    viewShell("Threads", threads.length ? threads.map((t) => h("li", { class: "t-card" }, h("p", { class: "meta" }, chanLabel(t.channel)), messageItem(t.parent, { inThread: true }),
      h("ol", { class: "t-messages t-indent" }, ...t.latest.map((m) => messageItem(m, { inThread: true }))),
      h("button", { type: "button", class: "btn small", onclick: tryRun(() => openThread(t.parent.id)) }, `Reply · ${t.parent.replyCount} replies`))) : h("li", { class: "meta" }, "Threads you start or reply to show up here."));
  } else if (view === "unreads") {
    const { unreads } = await api(T(`/workspaces/${ws}/unreads`));
    viewShell("All unreads", unreads.length ? unreads.map((u) => h("li", { class: "t-card" }, h("p", { class: "t-row" }, h("strong", {}, chanLabel(u.channel)), h("span", { class: "meta" }, `${u.channel.unread} new`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/channels/${u.channel.id}/read`), { method: "POST", body: {} }); await loadSidebar(); await showView("unreads"); }) }, "Mark as read"),
      h("button", { type: "button", class: "btn small", onclick: tryRun(() => openChannel(u.channel.id)) }, "Open")), h("ol", { class: "t-messages" }, ...u.messages.map((m) => messageItem(m, { inThread: true }))))) : h("li", { class: "meta" }, "You're all caught up."));
  } else if (view === "saved") {
    const [open, done] = await Promise.all([api(T(`/workspaces/${ws}/saved`)), api(T(`/workspaces/${ws}/saved?done=1`))]);
    const row = (s) => card(s.message, h("p", { class: "t-row" }, s.remindAt ? h("span", { class: "meta" }, `⏰ ${when(s.remindAt)}`) : null,
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/messages/${s.messageId}/save`), { method: "PUT", body: { done: !s.done } }); await loadSidebar(); await showView("saved"); }) }, s.done ? "Move back" : "Mark complete"),
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/messages/${s.messageId}/save`), { method: "PUT", body: { saved: false } }); await loadSidebar(); await showView("saved"); }) }, "Remove")));
    viewShell("Later", open.saved.length ? open.saved.map(row) : h("li", { class: "meta" }, "Save messages with ☆ to come back to them."), done.saved.length ? h("li", { class: "t-day" }, h("span", {}, "Completed")) : null, done.saved.map(row));
  } else if (view === "scheduled") {
    const { scheduled } = await api(T(`/workspaces/${ws}/scheduled`));
    viewShell("Scheduled messages", scheduled.length ? scheduled.map((s) => h("li", { class: "t-card" }, h("p", { class: "meta" }, `To ${chanLabel(s.channel)} · ${when(s.sendAt)}`), format(s.text),
      h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/scheduled/${s.id}`), { method: "DELETE" }); await loadSidebar(); await showView("scheduled"); }) }, "Cancel"))) : h("li", { class: "meta" }, "Use Schedule next to Send to send a message later."));
  } else if (view === "reminders") {
    const { reminders } = await api(T(`/workspaces/${ws}/reminders`));
    viewShell("Reminders", h("li", {}, h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
      const soon = new Date(Date.now() + 60 * 60_000);
      const r = await dialog("New reminder", [{ name: "text", label: "Remind me to", required: true, max: 1000 }, { name: "at", label: "When", type: "datetime-local", value: new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16), required: true }], "Add");
      if (r) { await api(T(`/workspaces/${ws}/reminders`), { method: "POST", body: { text: r.text, at: new Date(r.at).toISOString() } }); await loadSidebar(); await showView("reminders"); }
    }) }, "+ New reminder"), h("span", { class: "meta" }, " or type /remind me to … in 10m")),
    reminders.map((r) => h("li", { class: "t-card" }, h("p", {}, r.done ? h("s", {}, r.text) : r.text), h("p", { class: "meta" }, `${r.fired ? "Reminded" : "Due"} ${when(r.remindAt)}`),
      h("p", { class: "t-row" }, h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/reminders/${r.id}`), { method: "PATCH", body: { done: !r.done } }); await loadSidebar(); await showView("reminders"); }) }, r.done ? "Reopen" : "Mark complete"),
        h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/reminders/${r.id}`), { method: "PATCH", body: { at: new Date(Date.now() + 20 * 60_000).toISOString() } }); await showView("reminders"); }) }, "Snooze 20 min"),
        h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/reminders/${r.id}`), { method: "DELETE" }); await loadSidebar(); await showView("reminders"); }) }, "Delete")))));
  } else if (view === "drafts") {
    const { drafts } = await api(T(`/workspaces/${ws}/drafts`));
    serverDrafts = Object.assign(new Map(drafts.map((d) => [d.channel.id, d.text])), { ws });
    viewShell("Drafts", drafts.length ? drafts.map((d) => h("li", { class: "t-card" },
      h("p", { class: "meta" }, `${chanLabel(d.channel)} · ${when(d.updatedAt)}`),
      h("div", { class: "t-draft-text" }, format(d.text)),
      h("p", { class: "t-row" },
        h("button", { type: "button", class: "btn small primary", onclick: tryRun(() => openChannel(d.channel.id)) }, "Open"),
        h("button", { type: "button", class: "btn small", onclick: tryRun(async () => {
          if (!confirm("Delete this draft?")) return;
          await api(T(`/channels/${d.channel.id}/draft`), { method: "PUT", body: { text: "" } });
          try { localStorage.removeItem(`team.draft.${d.channel.id}`); } catch {}
          await loadSidebar();
          await showView("drafts");
        }) }, "Delete"))))
      : h("li", { class: "meta" }, "Messages you start but don't send are kept here, on all your devices."));
  } else if (view === "tasks") {
    const { tasks } = await api(T(`/workspaces/${ws}/tasks`));
    viewShell("My tasks", tasks.length ? h("li", {}, h("ul", { class: "t-tasks" }, ...tasks.map((t) => taskItem(t, { showChannel: true, onChange: async () => { await loadSidebar(); await showView("tasks"); } }))))
      : h("li", { class: "meta" }, "Tasks assigned to you in any channel's List show up here."));
  } else if (view === "files") {
    viewShell("Files", h("li", {}, await showFiles()));
  } else if (view === "people") {
    const [{ people }, { groups }] = await Promise.all([api(T(`/workspaces/${ws}/people`)), api(T(`/workspaces/${ws}/groups`))]);
    viewShell("People", h("li", {}, h("ul", { class: "t-people" }, ...people.map((p) => personRow(p)))),
      h("li", { class: "t-day" }, h("span", {}, "User groups")),
      groups.map((g) => h("li", { class: "t-card" }, h("strong", {}, `@${g.handle}`), ` ${g.name} · `, h("span", { class: "meta" }, g.members.map((m) => `@${m}`).join(" ")),
        h("p", { class: "t-row" }, h("button", { type: "button", class: "btn small", onclick: tryRun(() => editGroup(g)) }, "Edit"),
          h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { if (confirm(`Delete @${g.handle}?`)) { await api(T(`/workspaces/${ws}/groups/${g.handle}`), { method: "DELETE" }); await showView("people"); } }) }, "Delete")))),
      h("li", {}, h("button", { type: "button", class: "btn small", onclick: tryRun(() => editGroup(null)) }, "+ New user group")));
  }
}

async function editGroup(g) {
  const r = await dialog(g ? `Edit @${g.handle}` : "New user group", [
    { name: "handle", label: "Handle (people mention it as @handle)", value: g?.handle || "", required: true, max: 31 },
    { name: "name", label: "Name", value: g?.name || "", max: 80 },
    { name: "members", label: "Members (usernames, separated by spaces)", value: g?.members.join(" ") || "" },
  ], "Save");
  if (r) { await api(T(`/workspaces/${state.wsId}/groups`), { method: "POST", body: { ...r, members: r.members.split(/[\s,]+/).filter(Boolean) } }); await showView("people"); }
}

async function runSearch(q) {
  state.view = "search";
  const r = await api(T(`/workspaces/${state.wsId}/search?q=${encodeURIComponent(q)}`));
  viewShell(`Search: ${q}`,
    r.channels.length ? [h("li", { class: "t-day" }, h("span", {}, "Channels")), ...r.channels.map((c) => h("li", {}, h("button", { type: "button", class: "link", onclick: tryRun(() => openChannel(c.id)) }, chanLabel(c)), h("span", { class: "meta" }, ` ${c.memberCount} members${c.topic ? ` · ${c.topic}` : ""}`)))] : null,
    r.people.length ? [h("li", { class: "t-day" }, h("span", {}, "People")), h("li", {}, h("ul", { class: "t-people" }, ...r.people.map((p) => personRow(p))))] : null,
    r.files.length ? [h("li", { class: "t-day" }, h("span", {}, "Files")), ...r.files.map((f) => h("li", {}, h("a", { href: T(`/files/${f.id}`), download: f.name }, `📎 ${f.name}`)))] : null,
    h("li", { class: "t-day" }, h("span", {}, `Messages · ${r.messages.length}`)),
    r.messages.length ? r.messages.map((m) => card(m)) : h("li", { class: "meta" }, "No messages match. Filters: in:#channel in:@person from:@person has:link has:file has:reaction has:pin is:thread is:saved before:2026-01-31 after:… during:… \"exact phrase\""),
  );
}

// ---------- live events and notifications ----------

let refreshTimer = null;
function soon(fn) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => fn().catch((e) => showError(e.message)), 150); }

function connect() {
  state.events?.close();
  const es = new EventSource(T("/events"));
  state.events = es;
  es.addEventListener("team", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "huddle-signal") { onHuddleSignal(ev); return; }
    if (ev.type === "huddle-reaction") { if (ev.channelId === huddle.channelId) showHuddleReaction(ev.from, ev.emoji); return; }
    if (ev.type === "huddle" && ev.channelId === huddle.channelId) refreshHuddle().catch((err) => showError(err.message));
    if (ev.workspaceId !== state.wsId) return;
    if (ev.type === "typing") {
      if (ev.channelId === state.channel?.id || ev.parentId === state.thread?.parent.id) { state.typing.set(ev.username, Date.now()); renderTyping(); }
      return;
    }
    if (ev.type === "read" || ev.type === "presence" || ev.type === "members" || ev.type === "sections" || ev.type === "keywords") { soon(loadSidebar); return; }
    if (ev.type === "drafts") { serverDrafts = null; soon(async () => { await loadSidebar(); if (state.view === "drafts") await showView("drafts"); }); return; }
    if (ev.type === "emoji") { soon(async () => { await loadSidebar(); if (state.channel) renderMessages(null, false); }); return; }
    if (ev.type === "task") {
      soon(async () => {
        if (state.listChannel === ev.channelId && !$("#panel").hidden) await showList(ev.channelId);
        if (state.channel?.id === ev.channelId) await refreshChannel();
        if (state.view === "tasks") await showView("tasks");
        await loadSidebar();
      });
      return;
    }
    if (ev.type === "channel" && state.channel?.id === ev.channelId && !state.channel.member) {
      // A public channel you were only looking at may have been made private.
      soon(async () => {
        try { await refreshChannel(); } catch { showNote("That channel is private now."); state.channel = null; await loadSidebar(); if (state.bar.channels[0]) await openChannel(state.bar.channels[0].id); }
      });
      return;
    }
    if (ev.type === "message" && ev.sub !== state.me.sub) { notify(ev); state.typing.delete(ev.username); }
    if (ev.type === "message" && ev.mentioned?.includes(state.me.sub)) $("#badge-activity").hidden = false;
    soon(async () => {
      await loadSidebar();
      if (state.channel && ev.channelId === state.channel.id && (!ev.parentId || ev.alsoInChannel || ev.type !== "message")) await refreshChannel();
      if (state.channel && ev.parentId && ev.channelId === state.channel.id && ev.type === "message") await refreshChannel();
      if (state.thread && (ev.parentId === state.thread.parent.id || ev.messageId === state.thread.parent.id)) await openThread(state.thread.parent.id, true);
    });
  });
  es.onerror = () => {};
}

function renderTyping() {
  const now = Date.now();
  for (const [u, t] of state.typing) if (now - t > 5000) state.typing.delete(u);
  const names = [...state.typing.keys()];
  $("#typing").textContent = names.length ? `${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…` : "";
}
setInterval(renderTyping, 2000);

/** Your notification level for a channel: your own setting, or everything in conversations and mentions in channels. */
const notifyLevel = (c) => c?.notify || (c && (c.kind === "dm" || c.kind === "group") ? "all" : "mentions");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The first of your keywords that appears in the text as a whole word, if any. */
function keywordIn(text) {
  for (const k of state.bar?.keywords || []) {
    if (new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(k)}($|[^\\p{L}\\p{N}_])`, "iu").test(text)) return k;
  }
  return null;
}

async function notify(ev) {
  if (!state.bar || state.bar.me.dnd) return;
  if (ev.parentId && !ev.alsoInChannel && !ev.mentioned?.includes(state.me.sub)) return;
  const c = [...state.bar.channels, ...state.bar.direct].find((x) => x.id === ev.channelId);
  const level = notifyLevel(c);
  if (level === "nothing") return;
  const mentioned = ev.mentioned?.includes(state.me.sub);
  if (!mentioned && c?.muted) return;
  if (!mentioned && level !== "all" && !(state.bar.keywords || []).length) return;
  if (document.visibilityState === "visible" && state.channel?.id === ev.channelId) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const m = await api(T(`/messages/${ev.messageId}`)).catch(() => null);
  if (!m) return;
  const keyword = !mentioned && level !== "all" ? keywordIn(m.text) : null;
  if (!mentioned && level !== "all" && !keyword) return;
  const n = new Notification(`${m.sender.displayName}${c ? ` in ${chanLabel(c)}` : ""}${keyword ? ` · “${keyword}”` : ""}`, { body: m.text.slice(0, 140), tag: m.id });
  n.onclick = () => { window.focus(); jumpTo(m.id); };
}

async function editNotifications(c) {
  const r = await dialog(`Notifications for ${chanLabel(c)}`, [
    { name: "notify", label: "Notify me about", type: "select", value: c.notify || "default", options: [
      ["default", c.kind === "dm" || c.kind === "group" ? "Default (every message)" : "Default (mentions only)"],
      ["all", "Every new message"], ["mentions", "Mentions only"], ["nothing", "Nothing"]] },
    { note: "Keywords from your notification settings still count unless you choose Nothing." },
  ], "Save");
  if (r) { await api(T(`/channels/${c.id}/prefs`), { method: "PUT", body: { notify: r.notify } }); await loadSidebar(); if (state.channel?.id === c.id) await refreshChannel(); }
}

async function editKeywords() {
  const r = await dialog("Notification keywords", [
    { note: "Get a desktop notification when a message in a channel you're in contains one of these words, even without an @mention. Only you can see your keywords." },
    { name: "keywords", label: "Keywords, separated by commas", type: "textarea", rows: 3, max: 1200, value: (state.bar.keywords || []).join(", ") },
  ], "Save");
  if (r) { await api(T(`/workspaces/${state.wsId}/keywords`), { method: "PUT", body: { keywords: r.keywords } }); await loadSidebar(); }
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.channel) soon(refreshChannel); });

// ---------- huddles ----------
// Live audio/video calls in a channel. The server relays WebRTC signalling over the event stream;
// audio and video go directly between browsers (a full mesh). Each pair uses "perfect negotiation",
// so either side can renegotiate (camera on, screen share) without offers colliding.

const huddle = { channelId: null, view: null, local: null, video: null, screen: false, muted: false, peers: new Map(), tiles: new Map(), built: false };

function huddleButton(c) {
  if (huddle.channelId === c.id) return h("button", { type: "button", class: "btn small t-huddle-live", onclick: tryRun(leaveHuddle) }, "Leave huddle");
  if (!c.member || c.archived) return c.huddle ? h("span", { class: "meta" }, `🎧 Huddle · ${c.huddle.people}`) : null;
  return h("button", { type: "button", class: `btn small${c.huddle ? " t-huddle-live" : ""}`, onclick: tryRun(() => joinHuddle(c.id)) }, c.huddle ? `🎧 Join huddle · ${c.huddle.people}` : "🎧 Huddle");
}

async function joinHuddle(channelId) {
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) throw new Error("This browser cannot make calls.");
  if (huddle.channelId) await leaveHuddle();
  try {
    huddle.local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
  } catch (e) {
    throw new Error(e?.name === "NotAllowedError" ? "Allow microphone access to join the huddle." : "No microphone was found.");
  }
  Object.assign(huddle, { channelId, muted: false, video: null, screen: false });
  try {
    huddle.view = await api(T(`/channels/${channelId}/huddle/join`), { method: "POST", body: {} });
  } catch (e) {
    huddle.local.getTracks().forEach((t) => t.stop());
    Object.assign(huddle, { channelId: null, local: null });
    throw e;
  }
  // Whoever joins calls everyone already there.
  for (const p of huddle.view.people) if (p.sub !== state.me.sub) peer(p.sub);
  renderHuddle();
  if (state.channel) renderHead();
  await loadSidebar();
}

async function leaveHuddle() {
  const id = huddle.channelId;
  if (!id) return;
  for (const p of huddle.peers.values()) p.pc.close();
  huddle.peers.clear();
  huddle.local?.getTracks().forEach((t) => t.stop());
  huddle.video?.stop();
  Object.assign(huddle, { channelId: null, view: null, local: null, video: null, screen: false, muted: false });
  renderHuddle();
  await api(T(`/channels/${id}/huddle/leave`), { method: "POST", body: {} }).catch(() => {});
  if (state.channel) renderHead();
  await loadSidebar().catch(() => {});
}

// Closing the tab: tell the server right away (it also notices a dropped connection after 15 s).
window.addEventListener("pagehide", () => {
  if (huddle.channelId) fetch(T(`/channels/${huddle.channelId}/huddle/leave`), { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: "{}" }).catch(() => {});
});

const signal = (to, data) => api(T(`/channels/${huddle.channelId}/huddle/signal`), { method: "POST", body: { to, data } });

function peer(sub) {
  let p = huddle.peers.get(sub);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: huddle.view?.iceServers || [] });
  p = { pc, polite: state.me.sub > sub, makingOffer: false, ignoreOffer: false, stream: null, videoSender: null };
  huddle.peers.set(sub, p);
  pc.onnegotiationneeded = async () => {
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      await signal(sub, { description: pc.localDescription });
    } catch (e) {
      console.warn("huddle offer", e);
    } finally {
      p.makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => { if (huddle.channelId) signal(sub, { candidate: candidate ? candidate.toJSON() : null }).catch(() => {}); };
  pc.ontrack = ({ track, streams }) => {
    if (streams[0]) p.stream = streams[0];
    else { p.stream = p.stream || new MediaStream(); p.stream.addTrack(track); }
    renderHuddle();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") pc.restartIce();
    renderHuddle();
  };
  for (const t of huddle.local.getAudioTracks()) pc.addTrack(t, huddle.local);
  if (huddle.video) p.videoSender = pc.addTrack(huddle.video, huddle.local);
  return p;
}

async function onHuddleSignal(ev) {
  if (!huddle.channelId || ev.channelId !== huddle.channelId) return;
  const p = peer(ev.from);
  const { description, candidate } = ev.data || {};
  try {
    if (description) {
      const collision = description.type === "offer" && (p.makingOffer || p.pc.signalingState !== "stable");
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await p.pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await p.pc.setLocalDescription();
        await signal(ev.from, { description: p.pc.localDescription });
      }
    } else if (candidate !== undefined) {
      try {
        await p.pc.addIceCandidate(candidate || undefined);
      } catch (e) {
        if (!p.ignoreOffer) throw e;
      }
    }
  } catch (e) {
    console.warn("huddle signal", e);
  }
}

async function refreshHuddle() {
  if (!huddle.channelId) return;
  const { huddle: view } = await api(T(`/channels/${huddle.channelId}/huddle`));
  if (!view || !view.people.some((p) => p.sub === state.me.sub)) { await leaveHuddle(); return; }
  huddle.view = view;
  const present = new Set(view.people.map((p) => p.sub));
  for (const [sub, p] of huddle.peers) if (!present.has(sub)) { p.pc.close(); huddle.peers.delete(sub); }
  renderHuddle();
}

async function setVideoTrack(track) {
  const old = huddle.video;
  if (old) { huddle.local.removeTrack(old); old.stop(); }
  huddle.video = track;
  if (track) huddle.local.addTrack(track);
  for (const p of huddle.peers.values()) {
    if (p.videoSender) await p.videoSender.replaceTrack(track);
    else if (track) p.videoSender = p.pc.addTrack(track, huddle.local);
  }
}

const tellHuddle = (body) => api(T(`/channels/${huddle.channelId}/huddle`), { method: "PUT", body }).then((v) => { huddle.view = v; renderHuddle(); });

async function toggleMute() {
  huddle.muted = !huddle.muted;
  for (const t of huddle.local.getAudioTracks()) t.enabled = !huddle.muted;
  await tellHuddle({ muted: huddle.muted });
}

async function toggleCamera() {
  if (huddle.video && !huddle.screen) {
    await setVideoTrack(null);
    await tellHuddle({ video: false, screen: false });
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 } } });
  } catch (e) {
    throw new Error(e?.name === "NotAllowedError" ? "Allow camera access to turn on video." : "No camera was found.");
  }
  huddle.screen = false;
  await setVideoTrack(stream.getVideoTracks()[0]);
  await tellHuddle({ video: true, screen: false });
}

async function toggleScreen() {
  if (huddle.screen) {
    huddle.screen = false;
    await setVideoTrack(null);
    await tellHuddle({ video: false, screen: false });
    return;
  }
  if (!navigator.mediaDevices.getDisplayMedia) throw new Error("This browser cannot share the screen.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return; // The person closed the picker.
  }
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => { if (huddle.screen && huddle.video === track) tryRun(toggleScreen)(); });
  huddle.screen = true;
  await setVideoTrack(track);
  await tellHuddle({ video: true, screen: true });
}

function tileFor(person) {
  const me = person.sub === state.me.sub;
  let t = huddle.tiles.get(person.sub);
  if (!t) {
    const video = h("video", { autoplay: true, playsinline: true });
    video.muted = me; // never play your own microphone back to yourself
    t = { el: h("div", { class: "t-tile" }, h("span", { class: "t-tile-initial", "aria-hidden": "true" }, (person.displayName || "?")[0].toUpperCase()), video, h("span", { class: "t-tile-name" })), video };
    huddle.tiles.set(person.sub, t);
  }
  const stream = me ? huddle.local : huddle.peers.get(person.sub)?.stream;
  if (stream && t.video.srcObject !== stream) { t.video.srcObject = stream; t.video.play().catch(() => {}); }
  const muted = me ? huddle.muted : person.muted;
  const video = me ? !!huddle.video : person.video;
  const screen = me ? huddle.screen : person.screen;
  t.el.classList.toggle("on-camera", video);
  t.el.classList.toggle("muted", muted);
  const link = me ? "" : huddle.peers.get(person.sub)?.pc.connectionState;
  t.el.classList.toggle("hand", !!person.hand);
  t.el.querySelector(".t-tile-name").textContent = `${person.hand ? "✋ " : ""}${muted ? "🔇 " : ""}${person.displayName}${me ? " (you)" : ""}${screen ? " · sharing screen" : ""}${link && link !== "connected" ? ` · ${link}` : ""}`;
  return t;
}

const HUDDLE_REACTIONS = ["👍", "👏", "😂", "🎉", "❤️"];

/** Float an emoji up over the sender's tile for a couple of seconds. */
function showHuddleReaction(from, emoji) {
  const t = huddle.tiles.get(from);
  if (!t) return;
  const bubble = h("span", { class: "t-tile-react", "aria-hidden": "true" }, emoji);
  t.el.append(bubble);
  setTimeout(() => bubble.remove(), 2500);
  const who = huddle.view?.people.find((p) => p.sub === from);
  const live = $("#huddle-live");
  if (live && who) live.textContent = `${who.displayName} reacted ${emoji}`;
}

function renderHuddle() {
  const box = $("#huddle");
  if (!huddle.channelId || !huddle.view) {
    box.hidden = true;
    for (const t of huddle.tiles.values()) { t.video.srcObject = null; t.el.remove(); }
    huddle.tiles.clear();
    return;
  }
  if (!huddle.built) {
    box.replaceChildren(h("div", { class: "t-huddle-head" }), h("div", { class: "t-huddle-tiles" }), h("div", { class: "t-row t-huddle-controls" }), h("span", { id: "huddle-live", class: "sr-only", "aria-live": "polite" }));
    huddle.built = true;
  }
  box.hidden = false;
  const [head, tiles, controls] = box.children;
  const mine = huddle.view.people.find((p) => p.sub === state.me.sub);
  const c = state.bar && [...state.bar.channels, ...state.bar.direct].find((x) => x.id === huddle.channelId);
  head.replaceChildren(h("strong", {}, `🎧 ${c ? chanLabel(c) : "Huddle"}`), h("span", { class: "meta" }, ` · ${huddle.view.people.length} in the huddle`));
  const present = new Set();
  for (const person of huddle.view.people) {
    present.add(person.sub);
    const t = tileFor(person);
    if (t.el.parentNode !== tiles) tiles.append(t.el);
  }
  for (const [sub, t] of huddle.tiles) if (!present.has(sub)) { t.video.srcObject = null; t.el.remove(); huddle.tiles.delete(sub); }
  controls.replaceChildren(
    h("button", { type: "button", class: `btn small${huddle.muted ? " primary" : ""}`, "aria-pressed": String(huddle.muted), onclick: tryRun(toggleMute) }, huddle.muted ? "Unmute" : "Mute"),
    h("button", { type: "button", class: "btn small", "aria-pressed": String(!!huddle.video && !huddle.screen), onclick: tryRun(toggleCamera) }, huddle.video && !huddle.screen ? "Camera off" : "Camera on"),
    navigator.mediaDevices?.getDisplayMedia ? h("button", { type: "button", class: "btn small", "aria-pressed": String(huddle.screen), onclick: tryRun(toggleScreen) }, huddle.screen ? "Stop sharing" : "Share screen") : null,
    h("button", { type: "button", class: `btn small${mine?.hand ? " primary" : ""}`, "aria-pressed": String(!!mine?.hand), onclick: tryRun(() => tellHuddle({ hand: !mine?.hand })) }, mine?.hand ? "Lower hand" : "✋ Raise hand"),
    h("span", { class: "t-huddle-reacts", role: "group", "aria-label": "Send a reaction" },
      ...HUDDLE_REACTIONS.map((e) => h("button", { type: "button", class: "btn small", title: `Send ${e}`, onclick: tryRun(() => api(T(`/channels/${huddle.channelId}/huddle/react`), { method: "POST", body: { emoji: e } })) }, e))),
    h("button", { type: "button", class: "btn small t-huddle-leave", onclick: tryRun(leaveHuddle) }, "Leave"),
  );
  // Raised hands, oldest first in the list, so whoever is hosting can see who is waiting.
  const hands = huddle.view.people.filter((p) => p.hand);
  head.append(...(hands.length ? [h("span", { class: "meta" }, ` · ✋ ${hands.map((p) => p.displayName).join(", ")}`),
    huddle.view.startedBy === state.me.sub ? h("button", { type: "button", class: "link meta", onclick: tryRun(async () => { for (const p of hands) await tellHuddle({ lower: p.sub }); }) }, " Lower all") : null] : []).filter(Boolean));
}

// ---------- top-level wiring ----------

document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", tryRun(() => showView(b.dataset.view))));

$("#search-form").addEventListener("submit", tryRun(async (e) => { e.preventDefault(); const q = $("#search").value.trim(); if (q) await runSearch(q); }));

$("#ws-select").addEventListener("change", tryRun(async (e) => {
  if (e.target.value === "+") {
    const r = await dialog("Add a workspace", [{ name: "name", label: "New workspace name", max: 60 }, { note: "or" }, { name: "code", label: "Invite code", max: 64 }], "Continue");
    if (r?.name) state.wsId = (await api(T("/workspaces"), { method: "POST", body: { name: r.name } })).id;
    else if (r?.code) state.wsId = (await api(T("/join"), { method: "POST", body: { code: r.code } })).id;
  } else state.wsId = e.target.value;
  await start();
}));

$("#ws-menu").addEventListener("click", (e) => {
  const w = state.bar.workspace;
  const admin = ["owner", "admin"].includes(w.role);
  menu(e.currentTarget, [
    w.inviteCode && ["Invite people", async () => { await dialog(`Invite people to ${w.name}`, [{ note: "Share this invite code. People sign in with Cumulus ID, then choose Join." }, { name: "code", label: "Invite code", value: w.inviteCode }], "Done"); }],
    admin && ["Rename workspace", async () => { const r = await dialog("Rename workspace", [{ name: "name", label: "Name", value: w.name, max: 60 }]); if (r) { await api(T(`/workspaces/${w.id}`), { method: "PATCH", body: r }); await loadWorkspaces(); } }],
    admin && ["Reset invite code", async () => { if (confirm("Old invite codes will stop working.")) { await api(T(`/workspaces/${w.id}`), { method: "PATCH", body: { rotateInvite: true } }); await loadSidebar(); } }],
    admin && ["Export data", async () => {
      const r = await dialog(`Export ${w.name}`, [
        { note: "Downloads people, channels and messages as a JSON file. Direct messages and file contents are not included. A note in the default channel tells everyone an export was made." },
        w.role === "owner" ? { name: "private", label: "Include private channels", type: "checkbox" } : null,
      ].filter(Boolean), "Download");
      if (r) location.href = T(`/workspaces/${w.id}/export${r.private ? "?private=1" : ""}`);
    }],
    ["Custom emoji", () => showEmoji()],
    w.role === "owner" && ["Message retention…", () => editRetention(w)],
    ["Turn on desktop notifications", async () => { if ("Notification" in window) await Notification.requestPermission(); }],
    ["Notification keywords…", () => editKeywords()],
  ]);
});

async function showEmoji() {
  const { emoji } = await api(T(`/workspaces/${state.wsId}/emoji`));
  const w = state.bar.workspace;
  const admin = ["owner", "admin"].includes(w.role);
  const file = h("input", { type: "file", accept: "image/png,image/gif,image/webp,image/jpeg", class: "input" });
  const name = h("input", { class: "input", maxlength: 42, placeholder: "party-parrot" });
  file.addEventListener("change", () => { if (!name.value && file.files[0]) name.value = file.files[0].name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_+-]+/g, "-").slice(0, 40); });
  const add = tryRun(async (e) => {
    e.preventDefault();
    const f = file.files[0];
    if (!f) throw new Error("Choose an image");
    if (f.size > 128_000) throw new Error("Emoji images can be up to 128 KB");
    const data = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(new Error("could not read the image"));
      r.readAsDataURL(f);
    });
    await api(T(`/workspaces/${state.wsId}/emoji`), { method: "POST", body: { name: name.value, data } });
    await loadSidebar();
    await showEmoji();
  });
  panel("Custom emoji",
    w.role !== "guest" ? h("form", { class: "t-emoji-form", onsubmit: add },
      h("label", { class: "field" }, h("span", {}, "Image (PNG, GIF, WebP or JPEG, up to 128 KB)"), file),
      h("label", { class: "field" }, h("span", {}, "Name, used as :name:"), name),
      h("button", { type: "submit", class: "btn primary small" }, "Add emoji")) : null,
    emoji.length ? h("ul", { class: "t-emoji-list" }, ...emoji.map((e) => h("li", {},
      emojiNode(`:${e.name}:`), h("span", { class: "strong" }, ` :${e.name}: `), h("span", { class: "meta" }, `added by ${e.createdBy.displayName}`),
      e.createdBy.sub === state.me.sub || admin ? h("button", { type: "button", class: "link", onclick: tryRun(async () => {
        if (!confirm(`Remove :${e.name}:? Messages that use it will show the text instead.`)) return;
        await api(T(`/workspaces/${state.wsId}/emoji/${e.name}`), { method: "DELETE" });
        await loadSidebar();
        await showEmoji();
      }) }, " Remove") : null)))
      : h("p", { class: "meta" }, "No custom emoji yet."),
  );
}

$("#me-button").addEventListener("click", (e) => {
  const me = state.bar.me;
  menu(e.currentTarget, [
    ["Set a status", async () => {
      const r = await dialog("Set a status", [{ name: "emoji", label: "Emoji", value: me.statusEmoji || "💬", max: 42 }, { name: "text", label: "What's your status?", value: me.statusText || "", max: 100 },
        { name: "clear", label: "Clear after", type: "select", options: [["", "Don't clear"], ["30", "30 minutes"], ["60", "1 hour"], ["240", "4 hours"], ["1440", "Today"], ["10080", "This week"]] }], "Save");
      if (r) { await api(T(`/workspaces/${state.wsId}/status`), { method: "PUT", body: { emoji: r.emoji || null, text: r.text || null, until: r.clear ? new Date(Date.now() + Number(r.clear) * 60_000).toISOString() : null } }); await loadSidebar(); }
    }],
    (me.statusEmoji || me.statusText) && ["Clear status", async () => { await api(T(`/workspaces/${state.wsId}/status`), { method: "PUT", body: { emoji: null, text: null } }); await loadSidebar(); }],
    [me.presence === "away" ? "Set yourself as active" : "Set yourself as away", async () => { await api(T(`/workspaces/${state.wsId}/presence`), { method: "PUT", body: { away: me.presence !== "away" } }); await loadSidebar(); }],
    ["Notification schedule…", () => editSchedule()],
    me.dnd && !me.quietHours ? ["Resume notifications", async () => { await api(T(`/workspaces/${state.wsId}/presence`), { method: "PUT", body: { dndUntil: null } }); await loadSidebar(); }] : null,
    ...(!me.dnd ? [["Pause notifications 30 min", 30], ["Pause notifications 1 hour", 60], ["Pause notifications until tomorrow", 60 * 16]].map(([l, mins]) => [l, async () => { await api(T(`/workspaces/${state.wsId}/presence`), { method: "PUT", body: { dndUntil: new Date(Date.now() + mins * 60_000).toISOString() } }); await loadSidebar(); }]) : []),
    ["Profile", () => showProfile(me)],
  ]);
});

$("#new-channel").addEventListener("click", tryRun(async () => {
  const r = await dialog("Create a channel", [{ name: "name", label: "Name", required: true, max: 80, placeholder: "e.g. plan-budget" }, { name: "purpose", label: "Description (optional)", max: 250 }, { name: "private", label: "Make private (only invited people can see it)", type: "checkbox" }], "Create");
  if (!r) return;
  const c = await api(T(`/workspaces/${state.wsId}/channels`), { method: "POST", body: r });
  await openChannel(c.id);
}));

$("#browse").addEventListener("click", tryRun(async () => {
  const [{ channels }, archived] = await Promise.all([api(T(`/workspaces/${state.wsId}/channels`)), api(T(`/workspaces/${state.wsId}/channels?archived=1`))]);
  const row = (c) => h("li", {}, h("button", { type: "button", class: "link", onclick: tryRun(() => openChannel(c.id)) }, chanLabel(c)), h("span", { class: "meta" }, ` ${c.memberCount} members${c.member ? " · joined" : ""}${c.purpose ? ` · ${c.purpose}` : ""}`),
    !c.member && !c.archived ? h("button", { type: "button", class: "btn small", onclick: tryRun(async () => { await api(T(`/channels/${c.id}/join`), { method: "POST", body: {} }); await openChannel(c.id); }) }, "Join") : null);
  state.thread = null;
  panel("Channels", h("ul", { class: "t-people" }, ...channels.map(row)), archived.channels.length ? h("h3", {}, "Archived") : null, h("ul", { class: "t-people" }, ...archived.channels.map(row)));
}));

$("#new-dm").addEventListener("click", tryRun(async () => {
  const r = await dialog("New message", [{ name: "people", label: "To (usernames, separated by spaces; leave empty for notes to yourself)" }], "Open");
  if (!r) return;
  const c = await api(T(`/workspaces/${state.wsId}/conversations`), { method: "POST", body: { people: r.people.split(/[\s,]+/).filter(Boolean) } });
  await openChannel(c.id);
}));

$("#create-ws").addEventListener("submit", tryRun(async (e) => { e.preventDefault(); state.wsId = (await api(T("/workspaces"), { method: "POST", body: { name: $("#ws-name").value } })).id; await start(); }));
$("#join-ws").addEventListener("submit", tryRun(async (e) => { e.preventDefault(); state.wsId = (await api(T("/join"), { method: "POST", body: { code: $("#ws-code").value } })).id; await start(); }));
// The Cumulus://ID account bar's "Sign out" navigates to #signout (data-signout).
const signOutFromHash = async () => {
  if (location.hash !== "#signout") return;
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/team";
};
window.addEventListener("hashchange", signOutFromHash);
signOutFromHash();

// ---------- quick switcher and keyboard shortcuts ----------

/** Score how well a query matches a label: 3 starts with, 2 a word starts with, 1 contains, 0.5 letters in order, 0 no match. */
function matchScore(label, q) {
  const s = label.toLowerCase();
  if (!q) return 1;
  if (s.startsWith(q)) return 3;
  if (s.split(/[\s#@._-]+/).some((w) => w.startsWith(q))) return 2;
  if (s.includes(q)) return 1;
  let i = 0;
  for (const ch of s) if (ch === q[i]) i += 1;
  return i === q.length ? 0.5 : 0;
}

async function openSwitcher() {
  if (!state.bar || document.querySelector(".t-switcher")) return;
  const people = (await api(T(`/workspaces/${state.wsId}/people`))).people.filter((p) => !p.deactivated && p.sub !== state.me.sub);
  const open = await api(T(`/workspaces/${state.wsId}/channels`)).then((r) => r.channels).catch(() => []);
  const mine = [...state.bar.channels, ...state.bar.direct];
  const views = [["activity", "Activity"], ["threads", "Threads"], ["unreads", "All unreads"], ["saved", "Later"], ["drafts", "Drafts"], ["scheduled", "Scheduled"], ["reminders", "Reminders"], ["files", "Files"], ["people", "People"]];
  const candidates = [
    ...mine.map((c) => ({ label: chanLabel(c), hint: c.unread && !c.muted ? `${c.unread} new` : c.kind === "dm" || c.kind === "group" ? "Direct message" : "Channel", boost: c.unread ? 0.3 : 0, go: () => openChannel(c.id) })),
    ...open.filter((c) => !mine.some((m) => m.id === c.id)).map((c) => ({ label: chanLabel(c), hint: "Not joined · public channel", boost: 0, go: () => openChannel(c.id) })),
    ...people.filter((p) => !state.bar.direct.some((d) => d.kind === "dm" && d.people?.[0]?.sub === p.sub)).map((p) => ({ label: `${p.displayName} @${p.username}`, hint: "Person", boost: 0, go: async () => { const c = await api(T(`/workspaces/${state.wsId}/conversations`), { method: "POST", body: { people: [p.username] } }); await loadSidebar(); await openChannel(c.id); } })),
    ...views.map(([v, l]) => ({ label: l, hint: "View", boost: -0.2, go: () => showView(v) })),
  ];
  const input = h("input", { class: "input", type: "text", placeholder: "Jump to a channel, person or view…", "aria-label": "Jump to", autocomplete: "off", role: "combobox", "aria-controls": "t-switcher-list", "aria-expanded": "true" });
  const list = h("ul", { id: "t-switcher-list", role: "listbox", class: "t-switcher-list" });
  const box = h("div", { class: "t-switcher", role: "dialog", "aria-modal": "true", "aria-label": "Jump to" }, h("div", { class: "t-switcher-box" }, input, list, h("p", { class: "meta" }, "↑ ↓ to move · Enter to open · Esc to close · ? for all shortcuts")));
  let results = [];
  let active = 0;
  const close = () => { box.remove(); document.removeEventListener("keydown", trap, true); };
  const choose = (r) => { close(); tryRun(r.go)(); };
  const render = () => {
    const q = input.value.trim().toLowerCase().replace(/^[#@]/, "");
    results = candidates.map((c) => ({ ...c, base: matchScore(c.label, q) })).filter((c) => c.base > 0).map((c) => ({ ...c, score: c.base + (q ? c.boost : c.boost * 3) }))
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, 12);
    active = Math.min(active, Math.max(0, results.length - 1));
    list.replaceChildren(...results.map((r, i) => h("li", { role: "option", id: `t-sw-${i}`, "aria-selected": String(i === active), class: i === active ? "active" : "", onmousedown: (e) => { e.preventDefault(); choose(r); } }, h("span", {}, r.label), h("span", { class: "meta" }, r.hint))));
    if (!results.length) list.append(h("li", { class: "meta" }, "Nothing matches."));
    input.setAttribute("aria-activedescendant", results.length ? `t-sw-${active}` : "");
  };
  const trap = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(1, results.length); render(); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[active]) choose(results[active]); }
  };
  input.addEventListener("input", () => { active = 0; render(); });
  box.addEventListener("mousedown", (e) => { if (e.target === box) close(); });
  document.addEventListener("keydown", trap, true);
  document.body.append(box);
  render();
  input.focus();
}

/** Channels in the order they appear in the sidebar. */
const sidebarOrder = () => [...document.querySelectorAll("#starred li button, #sections li button, #channels li button, #direct li button")]
  .map((b) => [...state.bar.channels, ...state.bar.direct].find((c) => chanLabel(c) === b.querySelector(".name")?.textContent)).filter(Boolean);

function stepChannel(dir, unreadOnly) {
  const order = sidebarOrder();
  if (!order.length) return;
  let i = order.findIndex((c) => c.id === state.channel?.id);
  for (let n = 0; n < order.length; n += 1) {
    i = (i + dir + order.length) % order.length;
    if (!unreadOnly || (order[i].unread && !order[i].muted)) { openChannel(order[i].id); return; }
  }
}

const SHORTCUTS = [
  ["Ctrl/⌘ K", "Jump to a channel, person or view"],
  ["Ctrl/⌘ G or /", "Search"],
  ["Alt ↑ / Alt ↓", "Previous or next channel"],
  ["Alt Shift ↑ / ↓", "Previous or next unread channel"],
  ["Shift Esc", "Mark everything as read"],
  ["Esc", "Close the side panel; in a channel, mark it as read"],
  ["↑ in an empty message box", "Edit your last message"],
  ["Ctrl/⌘ / or ?", "Show these shortcuts"],
];
function showShortcuts() {
  panel("Keyboard shortcuts", h("table", { class: "t-shortcuts" }, ...SHORTCUTS.map(([k, d]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, d)))));
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inField = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target?.isContentEditable;
  const typing = inField && e.target.value;
  if (document.querySelector("dialog[open]")) return;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); openSwitcher().catch((err) => showError(err.message)); return; }
  if ((mod && e.key.toLowerCase() === "g") || (!inField && e.key === "/")) { e.preventDefault(); $("#search").focus(); return; }
  if ((mod && e.key === "/") || (!inField && e.key === "?")) { e.preventDefault(); showShortcuts(); return; }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); stepChannel(e.key === "ArrowUp" ? -1 : 1, e.shiftKey); return; }
  if (e.key === "Escape" && e.shiftKey && !typing) {
    e.preventDefault();
    tryRun(async () => { for (const c of [...state.bar.channels, ...state.bar.direct].filter((x) => x.unread)) await api(T(`/channels/${c.id}/read`), { method: "POST", body: {} }); await loadSidebar(); })();
    return;
  }
  if (e.key === "Escape" && !typing && !$("#panel").hidden) { $("#panel").hidden = true; state.thread = null; return; }
  if (e.key === "Escape" && !typing && state.channel?.unread) tryRun(async () => { await api(T(`/channels/${state.channel.id}/read`), { method: "POST", body: {} }); await loadSidebar(); })();
});

async function start(opts = {}) {
  if (!(await loadWorkspaces())) return;
  connect();
  if (opts.open === false) return;
  if (!(opts.route && await applyRoute(opts.route))) {
    const first = state.bar.channels.find((c) => c.name === "general") || state.bar.channels[0] || state.bar.direct[0];
    if (first) { routing = true; try { await openChannel(first.id); } finally { routing = false; } setRoute(`#/c/${first.id}`, true); }
  }
  const items = (await api(T(`/workspaces/${state.wsId}/activity`))).items;
  $("#badge-activity").hidden = !(items[0] && items[0].at > state.lastActivitySeen);
}

if (new URLSearchParams(location.search).get("error") === "sign-in-failed") showError("Sign-in failed. Try again.");
try {
  state.me = await api("/api/me");
  const person = state.me;
  window.CumulusBar?.setProfile({ name: person.name || person.username, username: person.username, email: person.email || undefined });
  // A link opened while signed out is kept across the sign-in, which can't carry the part after #.
  let pending = null;
  try { pending = sessionStorage.getItem("team.link"); sessionStorage.removeItem("team.link"); } catch {}
  if (pending && !routeNow() && /^#\/(c|m|v)\//.test(pending)) history.replaceState(null, "", pending);
  await start({ route: routeNow() });
  $("#me-button").hidden = !state.bar;
} catch (e) {
  if (/unauthorized/.test(e.message)) {
    $("#signed-out").hidden = false;
    window.CumulusBar?.setProfile(null);
    if (routeNow()) $("#signed-out").querySelectorAll("a").forEach((a) => a.addEventListener("click", () => { try { sessionStorage.setItem("team.link", location.hash); } catch {} }));
  }
  else showError(e.message);
}
