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
  const re = /(`[^`\n]+`)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)|(https?:\/\/[^\s<>"')\]]+)|(@[a-z0-9._-]+)|(#[a-z0-9_-]+)|(fabric:message\/[0-9a-f-]{36})/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h("code", {}, t.slice(1, -1)));
    else if (m[2]) out.push(h("strong", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[3]) out.push(h("em", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[4]) out.push(h("s", {}, ...inline(t.slice(1, -1), mentions)));
    else if (m[5]) out.push(h("a", { href: t, target: "_blank", rel: "noopener noreferrer" }, t));
    else if (m[6]) {
      const name = t.slice(1).toLowerCase().replace(/[._-]+$/, "");
      const me = state.me && (name === state.me.username || ["channel", "here", "everyone"].includes(name));
      out.push(h("span", { class: `mention${me ? " me" : ""}` }, t));
    } else if (m[7]) out.push(h("a", { href: "#", class: "chan", onclick: (e) => { e.preventDefault(); openChannelByName(t.slice(1)); } }, t));
    else if (m[8]) out.push(h("a", { href: "#", onclick: (e) => { e.preventDefault(); jumpTo(t.split("/")[1]); } }, "view message"));
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
  menu(anchor, [...EMOJI.map((e) => [e, () => onPick(e)]), ["Other…", async () => {
    const r = await dialog("React with", [{ name: "emoji", label: "Emoji or :short_code:", max: 42, required: true }]);
    if (r?.emoji) await onPick(r.emoji);
  }]]);
  document.querySelector(".t-menu")?.classList.add("emoji");
}

// ---------- sidebar ----------

async function loadSidebar() {
  state.bar = await api(T(`/workspaces/${state.wsId}`));
  const bar = state.bar;
  $("#me-button").hidden = false;
  $("#me-button").textContent = `${bar.me.statusEmoji ? `${bar.me.statusEmoji} ` : ""}${bar.me.displayName}${bar.me.dnd ? " · DND" : bar.me.presence === "away" ? " · away" : ""}`;
  $("#count-saved").textContent = bar.saved || "";
  $("#count-scheduled").textContent = bar.scheduled || "";
  $("#count-reminders").textContent = bar.reminders || "";
  const row = (c) => h("li", {}, h("button", {
    type: "button", class: `${c.unread && !c.muted ? "unread" : ""}${c.muted ? " muted" : ""}`, "aria-current": state.channel?.id === c.id ? "true" : null,
    onclick: tryRun(() => openChannel(c.id)),
  }, c.kind === "dm" && c.people?.[0] ? dot(c.people[0]) : null, h("span", { class: "name" }, chanLabel(c)), c.mentions ? h("span", { class: "badge" }, String(c.mentions)) : null));
  const all = [...bar.channels, ...bar.direct];
  $("#starred").replaceChildren(...all.filter((c) => c.starred).map(row));
  $("#starred").parentElement.hidden = !all.some((c) => c.starred);
  $("#channels").replaceChildren(...bar.channels.filter((c) => !c.starred).map(row));
  $("#direct").replaceChildren(...bar.direct.filter((c) => !c.starred).map(row));
  const unread = all.reduce((n, c) => n + (c.muted ? 0 : c.mentions), 0);
  document.title = `${unread ? `(${unread}) ` : ""}${bar.workspace.name} · FABRIC Teams`;
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
    ),
    h("p", { class: "meta t-topic" }, c.topic || c.purpose || (c.kind === "dm" ? "Direct message" : c.kind === "group" ? "Group conversation" : "Add a topic")),
    h("div", { class: "t-row t-head-actions" },
      h("button", { type: "button", class: "btn small", onclick: tryRun(showMembers) }, `${c.memberCount} ${c.memberCount === 1 ? "member" : "members"}`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(showPins) }, `Pins${c.pins ? ` ${c.pins}` : ""}`),
      h("button", { type: "button", class: "btn small", onclick: tryRun(showCanvas) }, c.canvas ? "Canvas •" : "Canvas"),
      h("button", { type: "button", class: "btn small", onclick: tryRun(() => showFiles(c.id)) }, "Files"),
      !c.member && !c.archived ? h("button", { type: "button", class: "btn primary small", onclick: tryRun(async () => { await api(T(`/channels/${c.id}/join`), { method: "POST", body: {} }); await openChannel(c.id); }) }, "Join channel") : null,
      h("button", { type: "button", class: "btn small", "aria-label": "Channel settings", onclick: (e) => channelMenu(e.currentTarget) }, "…"),
    ),
  );
  $("#bookmarks").replaceChildren(
    ...c.bookmarks.map((b) => h("li", {}, h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, b.title),
      h("button", { type: "button", class: "link", "aria-label": `Remove ${b.title}`, onclick: tryRun(async () => { await api(T(`/bookmarks/${b.id}`), { method: "DELETE" }); await refreshChannel(); }) }, "×"))),
    c.member ? h("li", {}, h("button", { type: "button", class: "link", onclick: tryRun(addBookmark) }, "+ Add a bookmark")) : null,
  );
  $("#composer").querySelector("textarea").placeholder = c.archived ? "This channel is archived" : `Message ${chanLabel(c)}`;
  $("#text").disabled = c.archived || !c.member;
}

function channelMenu(anchor) {
  const c = state.channel;
  const named = c.kind === "public" || c.kind === "private";
  menu(anchor, [
    named && ["Edit topic", async () => { const r = await dialog("Topic", [{ name: "topic", label: "Topic", value: c.topic, max: 250 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); } }],
    named && ["Edit description", async () => { const r = await dialog("Description", [{ name: "purpose", label: "Description", value: c.purpose, max: 250 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); } }],
    named && ["Rename", async () => { const r = await dialog("Rename channel", [{ name: "name", label: "Name", value: c.name, max: 80 }]); if (r) { await api(T(`/channels/${c.id}`), { method: "PATCH", body: r }); await refreshChannel(); await loadSidebar(); } }],
    c.kind !== "dm" && c.member && ["Add people", async () => { const r = await dialog("Add people", [{ name: "people", label: "Usernames, separated by spaces", required: true }]); if (r) { await api(T(`/channels/${c.id}/invite`), { method: "POST", body: { people: r.people.split(/[\s,]+/) } }); await refreshChannel(); } }],
    c.member && [c.muted ? "Unmute" : "Mute", async () => { await api(T(`/channels/${c.id}/prefs`), { method: "PUT", body: { muted: !c.muted } }); await refreshChannel(); await loadSidebar(); }],
    c.member && ["Mark as read", async () => { await api(T(`/channels/${c.id}/read`), { method: "POST", body: {} }); await loadSidebar(); }],
    named && !c.archived && ["Archive channel", async () => { if (confirm(`Archive #${c.name}? People can still read it.`)) { await api(T(`/channels/${c.id}/archive`), { method: "POST", body: { archived: true } }); await refreshChannel(); await loadSidebar(); } }],
    named && c.archived && ["Unarchive channel", async () => { await api(T(`/channels/${c.id}/archive`), { method: "POST", body: { archived: false } }); await refreshChannel(); await loadSidebar(); }],
    c.member && c.kind !== "dm" && !c.isDefault && ["Leave", async () => { await api(T(`/channels/${c.id}/leave`), { method: "POST", body: {} }); state.channel = null; await loadSidebar(); await openChannel(state.bar.channels[0].id); }],
  ]);
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
  if (!compact) li.append(h("div", { class: "t-who" }, dot(m.sender), h("button", { type: "button", class: "link strong", onclick: tryRun(() => showProfile(m.sender)) }, personName(m.sender)), h("span", { class: "meta" }, time(m.createdAt)), m.pinned ? h("span", { class: "meta" }, "📌 pinned") : null));
  const body = h("div", { class: "t-body" });
  if (m.deleted) body.append(h("p", { class: "meta" }, "This message was deleted."));
  else if (m.unreadable) body.append(h("p", { class: "meta" }, "This message could not be read."));
  else if (state.editing === m.id) body.append(editBox(m));
  else body.append(format(m.text));
  if (m.editedAt && !m.deleted) body.append(h("span", { class: "meta" }, " (edited)"));
  if (m.alsoInChannel && !inThread) body.prepend(h("p", { class: "meta" }, "replied to a thread"));
  for (const f of m.files) {
    const url = T(`/files/${f.id}`);
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.mime)) body.append(h("a", { href: url, class: "t-image" }, h("img", { src: `${url}?inline=1`, alt: f.name, loading: "lazy" })));
    body.append(h("a", { href: url, class: "t-filecard", download: f.name }, `📎 ${f.name}`, h("span", { class: "meta" }, ` ${size(f.size)}`)));
  }
  li.append(body);
  if (m.reactions.length) li.append(h("div", { class: "t-reactions" }, ...m.reactions.map((r) => h("button", {
    type: "button", class: r.mine ? "mine" : "", "aria-pressed": String(r.mine), title: r.subs.length > 0 ? `${r.count} reacted` : "",
    onclick: tryRun(async () => { await api(T(`/messages/${m.id}/reactions`), { method: "POST", body: { emoji: r.emoji } }); await afterChange(m); }),
  }, `${r.emoji} ${r.count}`)), h("button", { type: "button", class: "add", "aria-label": "Add reaction", onclick: (e) => emojiPicker(e.currentTarget, async (emoji) => { await api(T(`/messages/${m.id}/reactions`), { method: "POST", body: { emoji, on: true } }); await afterChange(m); }) }, "+")));
  if (m.replyCount && !inThread) li.append(h("button", { type: "button", class: "t-replies link", onclick: tryRun(() => openThread(m.id)) }, `${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"}`, h("span", { class: "meta" }, ` · last ${when(m.lastReplyAt)}`)));
  if (!m.deleted && !m.unreadable) li.append(actions(m, inThread));
  return li;
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
      ["Mark unread", async () => { await api(T(`/channels/${m.channelId}/read`), { method: "POST", body: { unreadFrom: m.id } }); await loadSidebar(); }],
      ["Copy link", async () => { await navigator.clipboard.writeText(`fabric:message/${m.id}`); }],
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
function saveDraft() { if (state.channel) { try { const v = $("#text").value; v ? localStorage.setItem(draftKey(), v) : localStorage.removeItem(draftKey()); } catch {} } }
function restoreDraft() { $("#text").value = localStorage.getItem(draftKey()) || ""; state.files = []; renderAttachments(); }

function renderAttachments() {
  $("#attachments").replaceChildren(...state.files.map((f) => h("span", { class: "t-chip" }, `📎 ${f.name}`, h("button", { type: "button", class: "link", "aria-label": `Remove ${f.name}`, onclick: () => { state.files = state.files.filter((x) => x !== f); renderAttachments(); } }, "×"))));
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
    try { localStorage.removeItem(draftKey()); } catch {}
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

const COMMANDS = ["/me", "/shrug", "/topic", "/purpose", "/rename", "/invite", "/kick", "/join", "/leave", "/archive", "/dm", "/remind me to ", "/status", "/away", "/active", "/dnd", "/mute", "/unmute", "/who", "/help"];
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

$("#file").addEventListener("change", tryRun(async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !state.channel) return;
  state.files.push(await upload(file, state.channel.id));
  renderAttachments();
}));

$("#schedule").addEventListener("click", tryRun(async () => {
  const text = $("#text").value;
  if (!text.trim()) throw new Error("Write the message first");
  const soon = new Date(Date.now() + 60 * 60_000);
  const local = new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const r = await dialog("Schedule message", [{ name: "at", label: "Send at", type: "datetime-local", value: local, required: true }], "Schedule");
  if (!r) return;
  await api(T(`/channels/${state.channel.id}/schedule`), { method: "POST", body: { text, sendAt: new Date(r.at).toISOString() } });
  $("#text").value = "";
  try { localStorage.removeItem(draftKey()); } catch {}
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
  $("#panel").hidden = false;
  $("#panel-title").textContent = title;
  $("#panel-body").replaceChildren(...content);
}
$("#panel-close").addEventListener("click", () => { $("#panel").hidden = true; state.thread = null; });

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
  panel(`Thread in ${chanLabel(t.channel)}`, list, h("form", { class: "t-composer", onsubmit: (e) => { e.preventDefault(); submit(); } }, ta,
    h("div", { class: "t-composer-bar" }, h("label", { for: "thread-also", class: "meta" }, also, ` Also send to ${chanLabel(t.channel)}`), h("button", { class: "btn primary small", type: "submit" }, "Reply"))));
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
    h("p", {}, dot(p), ` ${p.presence === "active" ? "Active" : "Away"}${p.dnd ? ` · Do not disturb until ${time(p.dndUntil)}` : ""}`),
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
    if (ev.workspaceId !== state.wsId) return;
    if (ev.type === "typing") {
      if (ev.channelId === state.channel?.id || ev.parentId === state.thread?.parent.id) { state.typing.set(ev.username, Date.now()); renderTyping(); }
      return;
    }
    if (ev.type === "read" || ev.type === "presence" || ev.type === "members") { soon(loadSidebar); return; }
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

async function notify(ev) {
  if (!state.bar || state.bar.me.dnd) return;
  const c = [...state.bar.channels, ...state.bar.direct].find((x) => x.id === ev.channelId);
  if (c?.muted && !ev.mentioned?.includes(state.me.sub)) return;
  if (!ev.mentioned?.includes(state.me.sub)) return;
  if (document.visibilityState === "visible" && state.channel?.id === ev.channelId) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const m = await api(T(`/messages/${ev.messageId}`)).catch(() => null);
  if (!m) return;
  const n = new Notification(`${m.sender.displayName}${c ? ` in ${chanLabel(c)}` : ""}`, { body: m.text.slice(0, 140), tag: m.id });
  n.onclick = () => { window.focus(); jumpTo(m.id); };
}

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.channel) soon(refreshChannel); });

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
    ["Turn on desktop notifications", async () => { if ("Notification" in window) await Notification.requestPermission(); }],
  ]);
});

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
    me.dnd ? ["Resume notifications", async () => { await api(T(`/workspaces/${state.wsId}/presence`), { method: "PUT", body: { dndUntil: null } }); await loadSidebar(); }] : null,
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
$("#logout").addEventListener("click", tryRun(async () => { await api("/api/auth/logout", { method: "POST" }); location.href = "/team"; }));

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search").focus(); }
  const typing = (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && e.target.value;
  if (e.key === "Escape" && !typing && !$("#panel").hidden && !document.querySelector("dialog[open]")) { $("#panel").hidden = true; state.thread = null; }
});

async function start() {
  if (!(await loadWorkspaces())) return;
  connect();
  const first = state.bar.channels.find((c) => c.name === "general") || state.bar.channels[0] || state.bar.direct[0];
  if (first) await openChannel(first.id);
  const items = (await api(T(`/workspaces/${state.wsId}/activity`))).items;
  $("#badge-activity").hidden = !(items[0] && items[0].at > state.lastActivitySeen);
}

if (new URLSearchParams(location.search).get("error") === "sign-in-failed") showError("Sign-in failed. Try again.");
try {
  state.me = await api("/api/me");
  $("#logout").hidden = false;
  await start();
  $("#me-button").hidden = !state.bar;
} catch (e) {
  if (/unauthorized/.test(e.message)) $("#signed-out").hidden = false;
  else showError(e.message);
}
