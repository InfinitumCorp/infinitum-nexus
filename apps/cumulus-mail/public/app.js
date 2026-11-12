import { searchThreads, tokenize, SEARCH_TIPS } from "/search.js";

const MAIL_DOMAIN = globalThis.CUMULUS?.mailDomain || "cumuluscloud.app";

const state = { view: "mail", box: "inbox", filter: "primary", query: "", selected: null, data: null, composer: null, error: "", wallet: null, clean: null, busy: "", picked: new Set(), cursor: -1, toast: null, help: false };

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "value") node.value = value;
    else if (key === "checked") node.checked = Boolean(value);
    else if (key === "style") node.style.cssText = value; // CSSOM, allowed by the page's CSP (style attributes are not)
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key.startsWith("aria-")) node.setAttribute(key, String(value));
    else if (value === true) node.setAttribute(key, "");
    else if (value != null && value !== false) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child?.nodeType ? child : document.createTextNode(child ?? ""));
  return node;
};
const none = () => document.createTextNode("");

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-cumulus": "1" },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.data = null;
    renderAuth();
    throw new Error(payload.error || "Please sign in");
  }
  if (!response.ok) throw new Error(payload.error || "Request failed");
  if (payload.state) state.data = { ...state.data, ...payload.state };
  else if (payload.messages) state.data = { ...state.data, ...payload };
  if (payload.clean) state.clean = payload.clean;
  return payload;
}

async function act(fn) {
  try {
    state.error = "";
    await fn();
  } catch (error) {
    state.error = error.message;
  }
  render();
}

/* ---------------- Conversation actions and Undo ---------------- */

let toastTimer;
function showToast(text, undo, action) {
  state.toast = { text, undo, action };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.toast = null; render(); }, 7000);
}

const DONE = {
  archive: (n) => (n === 1 ? "Conversation archived." : `${n} conversations archived.`),
  trash: (n) => (n === 1 ? "Conversation moved to Trash." : `${n} conversations moved to Trash.`),
  inbox: (n) => (n === 1 ? "Conversation moved to Inbox." : `${n} conversations moved to Inbox.`),
  read: (n) => (n === 1 ? "Marked as read." : `${n} conversations marked as read.`),
  unread: (n) => (n === 1 ? "Marked as unread." : `${n} conversations marked as unread.`),
  star: () => "Starred.",
  unstar: () => "Star removed.",
  snooze: () => "Snoozed until 08:00 UTC tomorrow.",
};

async function threadAct(threadIds, action) {
  if (!threadIds.length) return;
  await act(async () => {
    const r = await api("/api/threads", { threadIds, action, box: state.box });
    state.picked.clear();
    if (r.count) showToast(DONE[action](r.count), r.undo);
  });
}

async function undo(id) {
  state.toast = null;
  await act(async () => {
    const r = await api("/api/undo", { id });
    showToast(r.restored ? "Action undone." : "Nothing to undo.");
  });
}

/* ---------------- Mail ---------------- */

const UPDATES = new Set(["newsletter", "notification", "receipt", "bounce"]);

function inBox(message, box) {
  const until = message.snoozeUntil ? Date.parse(message.snoozeUntil) : 0;
  const snoozed = Number.isFinite(until) && until > Date.now() && message.folder !== "trash" && message.folder !== "drafts";
  if (box === "snoozed") return snoozed;
  if (snoozed) return false;
  if (box === "outbox") return message.folder === "sent" && (message.delivery || []).some((hop) => hop.status === "outbound");
  if (box === "starred") return message.starred && message.folder !== "trash";
  if (box === "scheduled") return message.folder === "drafts" && Boolean(message.sendAt);
  if (box === "drafts") return message.folder === "drafts" && !message.sendAt;
  return message.folder === box;
}

function rows() {
  const messages = state.data.messages;
  if (state.query.trim()) return searchThreads(messages, state.query);
  const latest = new Map();
  for (const message of messages.filter((item) => inBox(item, state.box))) {
    if (state.box === "inbox" && state.filter === "primary" && message.kind !== "person") continue;
    if (state.box === "inbox" && state.filter === "updates" && !UPDATES.has(message.kind)) continue;
    const prev = latest.get(message.threadId);
    if (!prev || prev.at < message.at) latest.set(message.threadId, message);
  }
  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

const mine = (message) => message.from.email === state.data.me.email;
const title = (message) => (mine(message) ? `To ${message.to[0]?.name || "someone"}` : message.from.name);
const size = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

function shortDate(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(d);
}

const blankComposer = (over = {}) => ({ to: "", cc: "", subject: "", body: "", attachments: [], ...over });

async function openMessage(message) {
  if (message.folder === "drafts" && message.sendAt) {
    state.selected = message.id;
    state.composer = null;
    render();
    return;
  }
  if (message.folder === "drafts") {
    state.composer = blankComposer({ draftId: message.id, threadId: message.threadId, to: message.to.map((p) => p.email).join(", "), subject: message.subject, body: message.body, attachments: message.attachments || [] });
    render();
    return;
  }
  state.selected = message.id;
  state.composer = null;
  
  await act(() => api("/api/read", { threadId: message.threadId }));
}

function go(view) {
  state.view = view;
  state.error = "";
  state.selected = null;
  
  if (view === "wallet") loadWallet();
  if (view === "clean") loadClean();
  render();
}

function render() {
  const data = state.data;
  if (!data) return;
  const root = document.querySelector("#app");
  const scroll = root.querySelector(".rows")?.scrollTop ?? 0;
  root.replaceChildren();
  const selected = data.messages.find((message) => message.id === state.selected);
  const search = el("input", { placeholder: "Search mail", "aria-label": "Search mail", value: state.query, onInput: (event) => { state.query = event.target.value; render(); document.querySelector(".search input")?.focus(); } });
  const initial = (data.me.name || data.me.email).trim().charAt(0).toUpperCase();
  root.append(
    el("header", {}, [
      el("div", { class: "brand" }, [el("div", { class: "mark" }, ["Cumulus://Mail", el("sup", { class: "tm" }, ["™"])])]),
      el("label", { class: "search" }, [el("span", { class: "glass", "aria-hidden": "true" }, ["⌕"]), search]),
      el("button", { class: "avatar", title: `${data.me.name} · ${data.me.email}`, "aria-label": "Your Cumulus://ID", onClick: () => go("account") }, [initial]),
    ]),
    el("div", { class: "layout" }, [
      sidebar(data),
      el("main", { class: "panel" }, [state.view === "mail" ? (selected ? (selected.sendAt && selected.folder === "drafts" ? scheduledView(selected) : reader(selected)) : list()) : aux(data)]),
    ]),
  );
  const rowsNode = root.querySelector(".rows");
  if (rowsNode) rowsNode.scrollTop = scroll;
  if (state.query) { const input = root.querySelector(".search input"); input.setSelectionRange(input.value.length, input.value.length); }
  if (state.composer && !state.composer.inline) root.append(modal());
  if (state.toast) root.append(el("div", { class: "toast", role: "status" }, [
    el("span", {}, [state.toast.text]),
    state.toast.undo ? el("button", { onClick: () => undo(state.toast.undo) }, ["Undo"]) : none(),
    state.toast.action ? el("button", { onClick: () => { const run = state.toast.action.run; state.toast = null; run(); } }, [state.toast.action.label]) : none(),
    el("button", { class: "x", "aria-label": "Dismiss", onClick: () => { state.toast = null; render(); } }, ["×"]),
  ]));
  if (state.help) root.append(helpDialog());
  document.title = data.unread ? `Inbox (${data.unread}) · Cumulus://Mail™` : "Cumulus://Mail™";
}

const SHORTCUTS = [
  ["c", "Compose"], ["/", "Search"], ["j / k", "Next / previous conversation"], ["o or Enter", "Open"], ["u", "Back to the list"],
  ["e", "Archive"], ["#", "Move to Trash"], ["r", "Reply"], ["s", "Star"], ["x", "Select"],
  ["Shift + i", "Mark as read"], ["Shift + u", "Mark as unread"], ["z", "Undo"], ["g then i", "Go to Inbox"], ["?", "Show shortcuts"],
];

function helpDialog() {
  return el("div", { class: "scrim center", onClick: (e) => { if (e.target === e.currentTarget) { state.help = false; render(); } } }, [
    el("div", { class: "dialog help", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("div", { class: "dialog-head" }, [el("h2", {}, ["Keyboard shortcuts"]), el("button", { class: "quiet", "aria-label": "Close", onClick: () => { state.help = false; render(); } }, ["×"])]),
      el("div", { class: "keys" }, SHORTCUTS.map(([k, label]) => el("div", { class: "key" }, [el("kbd", {}, [k]), el("span", {}, [label])]))),
    ]),
  ]);
}

function sidebar(data) {
  const boxes = [["inbox", "Inbox"], ["snoozed", "Snoozed"], ["outbox", "Outbox"], ["starred", "Starred"], ["sent", "Sent"], ["drafts", "Drafts"], ["scheduled", "Scheduled"], ["archive", "Archive"], ["trash", "Trash"]];
  const views = [["clean", "Clean"], ["wallet", "Wallet"], ["contacts", "People"], ["tasks", "Architect"]];
  const navButton = (current, label, onClick, extra) => el("button", { "aria-current": current, onClick }, [label, extra ?? none()]);
  return el("nav", { "aria-label": "Mail" }, [
    el("button", { class: "compose", onClick: () => { state.composer = blankComposer(); state.error = ""; render(); } }, [el("span", { "aria-hidden": "true" }, ["✎"]), "Compose"]),
    ...boxes.map(([id, label]) => navButton(state.view === "mail" && state.box === id, label, () => { state.box = id; state.filter = "all"; go("mail"); },
      id === "inbox" && data.unread ? el("span", { class: "count" }, [String(data.unread)]) : null)),
    el("hr"),
    ...views.map(([id, label]) => navButton(state.view === id, label, () => go(id))),
    el("button", { onClick: () => { location.href = "/labyrinth"; } }, ["Labyrinth *LBRNTH", el("sup", { class: "tm" }, ["™"])]),
    el("hr"),
    el("button", { onClick: () => { location.href = "/drive/"; } }, ["Drive"]),
    el("button", { onClick: () => { location.href = "/drive/#/new/dox"; } }, ["Dox"]),
    el("button", { onClick: () => { location.href = "/drive/#/new/spreads"; } }, ["Spreads"]),
    el("button", { onClick: () => { location.href = "/drive/#/new/podium"; } }, ["Podium"]),
    el("button", { class: "mobile-only", "aria-current": state.view === "account", onClick: () => go("account") }, ["Account"]),
    el("button", { class: "me", onClick: () => go("account") }, [
      el("div", { class: "meter" }, [el("span", { style: `width:${Math.max(1, data.quota.pct)}%` })]),
      el("div", { class: "sub" }, [`${data.quota.label} used`]),
    ]),
  ]);
}

function list() {
  const list_ = rows();
  state.visible = list_;
  if (state.cursor >= list_.length) state.cursor = list_.length - 1;
  const items = list_.map((message, index) => el("div", { class: `row${message.unread ? " unread" : ""}${state.picked.has(message.threadId) ? " picked" : ""}${index === state.cursor ? " cursor" : ""}`, role: "button", tabindex: "0", "data-index": String(index), onClick: () => openMessage(message), onKeydown: (e) => { if (e.key === "Enter") openMessage(message); } }, [
    el("input", { type: "checkbox", class: "pick", "aria-label": `Select ${message.subject || "conversation"}`, checked: state.picked.has(message.threadId), onClick: (e) => {
      e.stopPropagation();
      if (e.target.checked) state.picked.add(message.threadId); else state.picked.delete(message.threadId);
      render();
    } }),
    el("button", { class: `star${message.starred ? " on" : ""}`, "aria-label": message.starred ? "Unstar" : "Star", onClick: (e) => { e.stopPropagation(); threadAct([message.threadId], message.starred ? "unstar" : "star"); } }, [message.starred ? "★" : "☆"]),
    el("span", { class: "who" }, [title(message)]),
    el("span", { class: "what" }, [
      message.payment ? el("span", { class: "tag" }, [`${message.payment.amount} ${message.payment.asset}`]) : none(),
      message.attachments?.length ? el("span", { class: "tag" }, ["File"]) : none(),
      el("b", {}, [message.subject || "(no subject)"]),
      el("span", { class: "snip", translate: "no" }, [` — ${message.body.replace(/\s+/g, " ").slice(0, 160)}`]),
    ]),
    el("span", { class: "when" }, [shortDate(message.at)]),
  ]));
  const unreadIn = (pred) => new Set(state.data.messages.filter((m) => m.folder === "inbox" && m.unread && pred(m)).map((m) => m.threadId)).size;
  const has = (tip) => tokenize(state.query).some((t) => `${t.negate ? "-" : ""}${t.key ? t.key + ":" : ""}${t.value}` === tip);
  const toggleTip = (tip) => {
    state.query = has(tip) ? state.query.split(/\s+/).filter((w) => w.toLowerCase() !== tip).join(" ") : `${state.query.trim()} ${tip}`.trim();
    state.cursor = -1;
    render();
  };
  const tabs = state.query.trim()
    ? el("div", { class: "chips", role: "toolbar", "aria-label": "Refine search" }, [
        el("span", { class: "sub" }, ["Search all mail"]),
        ...SEARCH_TIPS.map(([tip, label]) => el("button", { class: `chip${has(tip) ? " on" : ""}`, "aria-pressed": has(tip), title: tip, onClick: () => toggleTip(tip) }, [label])),
        el("button", { class: "quiet", onClick: () => { state.query = ""; render(); } }, ["Clear"]),
      ])
    : state.box === "inbox"
    ? el("div", { class: "tabs", role: "tablist" }, [
        ["primary", "Primary", unreadIn((m) => m.kind === "person")],
        ["updates", "Updates", unreadIn((m) => UPDATES.has(m.kind))],
        ["all", "All mail", 0],
      ].map(([id, label, n]) => el("button", { role: "tab", "aria-selected": state.filter === id, onClick: () => { state.filter = id; render(); } }, [label, n ? el("span", { class: "pill" }, [`${n} new`]) : none()])))
    : none();
  const ids = list_.map((m) => m.threadId);
  const picked = ids.filter((id) => state.picked.has(id));
  const all = el("input", { type: "checkbox", class: "pick", "aria-label": "Select all", checked: ids.length > 0 && picked.length === ids.length, onClick: () => {
    if (picked.length === ids.length) state.picked.clear(); else ids.forEach((id) => state.picked.add(id));
    render();
  } });
  if (picked.length && picked.length < ids.length) all.indeterminate = true;
  const bulk = (label, action, title) => el("button", { class: "quiet", title, onClick: () => threadAct(picked, action) }, [label]);
  const head = el("div", { class: "list-head" }, [
    all,
    ...(picked.length
      ? [
          state.box === "inbox" ? bulk("Archive", "archive", "Archive (e)") : none(),
          state.box === "archive" || state.box === "trash" ? bulk("Move to inbox", "inbox") : none(),
          state.box !== "trash" ? bulk("Trash", "trash", "Move to Trash (#)") : none(),
          bulk("Mark read", "read", "Shift + i"),
          bulk("Mark unread", "unread", "Shift + u"),
          el("span", { class: "sub" }, [`${picked.length} selected`]),
        ]
      : [el("button", { class: "icon", "aria-label": "Refresh", title: "Refresh", onClick: () => refresh(true) }, ["↻"])]),
    el("span", { class: "spacer" }),
    state.box === "trash" && items.length
      ? el("button", { class: "quiet danger", onClick: () => { if (confirm("Delete everything in Trash forever?")) act(() => api("/api/trash/empty", {})); } }, ["Empty trash now"])
      : none(),
    el("span", { class: "sub" }, [items.length ? `1–${items.length} of ${items.length}` : ""]),
  ]);
  const empty = state.query ? "No mail matches that search." : state.box === "inbox" && state.filter === "primary" ? "No mail from people. You're all caught up." : "Nothing here.";
  return el("section", { class: "list", "aria-label": state.box }, [head, tabs, el("div", { class: "rows" }, items.length ? items : [el("p", { class: "empty" }, [empty])])]);
}

function paymentCard(item) {
  const outgoing = mine(item) && !item.system;
  return el("div", { class: "payment" }, [
    el("div", { class: "sub" }, ["FIRM Wallet"]),
    el("strong", {}, [`${item.system ? "" : outgoing ? "Sent " : "Received "}${item.payment.amount} ${item.payment.asset}`]),
    el("div", { class: "sub" }, [`${item.payment.txId.slice(0, 15)}… · recorded on Firmament`]),
  ]);
}

/* ---------------- Schedule send ---------------- */

const longDate = (iso) => new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** Gmail's quick choices: tomorrow morning, tomorrow afternoon, next Monday morning. */
function laterChoices(now = new Date()) {
  const at = (days, hour) => { const d = new Date(now); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const monday = (8 - now.getDay()) % 7 || 7;
  return [["Tomorrow morning", at(1, 8)], ["Tomorrow afternoon", at(1, 13)], ["Monday morning", at(monday, 8)]];
}

async function scheduleSend(when) {
  const at = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= Date.now()) { state.error = "Pick a time in the future."; render(); return; }
  clearTimeout(draftTimer);
  if (draftSaving) await draftSaving;
  const form = state.composer;
  if (stillUploading(form)) { state.error = "Wait for your files to finish uploading."; render(); return; }
  if (form.payment?.amount) { state.error = "Payments go out right away. Send this one now."; render(); return; }
  try {
    form.sent = true;
    const r = await api("/api/schedule", { ...form, payment: undefined, sendAt: at.toISOString() });
    state.composer = null;
    state.error = "";
    showToast(`Scheduled for ${longDate(r.sendAt)}.`, undefined, { label: "Cancel", run: () => cancelSchedule(r.id) });
  } catch (error) {
    form.sent = false;
    state.error = error.message;
  }
  render();
}

/** Cancel a scheduled send and reopen it as a draft to edit, like Gmail. */
async function cancelSchedule(id) {
  await act(async () => {
    await api("/api/schedule/cancel", { id });
    const draft = state.data.messages.find((m) => m.id === id);
    state.selected = null;
    if (draft) {
      state.composer = blankComposer({ draftId: draft.id, threadId: draft.threadId, to: draft.to.map((p) => p.email).join(", "), cc: draft.cc.map((p) => p.email).join(", "), subject: draft.subject === "(no subject)" ? "" : draft.subject, body: draft.body, attachments: draft.attachments || [] });
    }
    showToast("Send canceled. It's back in Drafts.");
  });
}

function scheduledView(message) {
  const close = () => { state.selected = null; render(); };
  return el("section", { class: "reader" }, [
    el("div", { class: "tools" }, [
      el("button", { class: "icon", "aria-label": "Back to Scheduled", title: "Back to Scheduled", onClick: close }, ["←"]),
      el("button", { class: "quiet", onClick: () => cancelSchedule(message.id) }, ["Cancel send"]),
    ]),
    el("div", { class: "sheet" }, [
      el("h1", {}, [message.subject || "(no subject)"]),
      el("p", { class: "scheduled-note" }, [`🕒 Sends ${longDate(message.sendAt)}`]),
      el("p", { class: "sub" }, [`To ${message.to.map((p) => p.name || p.email).join(", ")}${message.cc.length ? ` · Cc ${message.cc.map((p) => p.name || p.email).join(", ")}` : ""}`]),
      el("div", { class: "scheduled-body", translate: "no" }, [message.body]),
    ]),
  ]);
}

/* ---------------- Recipient suggestions ---------------- */

function people() {
  const data = state.data;
  const seen = new Map();
  const add = (p) => {
    const email = p?.email?.toLowerCase();
    if (!email || email === data.me.email || seen.has(email)) return;
    seen.set(email, { name: p.name || "", email });
  };
  (data.contacts || []).forEach(add);
  [...data.messages].sort((a, b) => (a.at < b.at ? 1 : -1)).forEach((m) => {
    if (m.system) return;
    if (mine(m)) [...m.to, ...m.cc].forEach(add); else add(m.from);
  });
  return [...seen.values()];
}

/** Suggest people for the last address being typed in a To or Cc box. */
function suggestFor(input) {
  const parts = input.value.split(",");
  const typed = parts[parts.length - 1].trim().toLowerCase();
  const chosen = new Set(parts.slice(0, -1).map((x) => x.trim().toLowerCase()));
  const list = typed ? people().filter((p) => !chosen.has(p.email) && `${p.name} ${p.email}`.toLowerCase().includes(typed)).slice(0, 5) : [];
  const field = input.closest(".field");
  field.querySelector(".suggestions")?.remove();
  input.onkeydown = null;
  if (!list.length || (list.length === 1 && list[0].email === typed)) return;
  const pick = (p) => {
    parts[parts.length - 1] = ` ${p.email}`;
    input.value = `${parts.join(",").trim()}, `;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  };
  field.append(el("div", { class: "suggestions", role: "listbox" }, list.map((p, i) => el("button", {
    type: "button", role: "option", class: i === 0 ? "first" : "",
    onMousedown: (e) => { e.preventDefault(); pick(p); },
  }, [el("b", {}, [p.name || p.email]), p.name ? el("span", { class: "sub" }, [p.email]) : none()]))));
  input.onkeydown = (e) => {
    const box = field.querySelector(".suggestions");
    if (!box) return;
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pick(list[0]); }
    if (e.key === "Escape") box.remove();
  };
}

function reader(message) {
  const thread = state.data.messages.filter((item) => item.threadId === message.threadId && item.folder !== "drafts" && (item.folder !== "trash" || message.folder === "trash")).sort((a, b) => (a.at < b.at ? -1 : 1));
  const e2e = [message.from, ...message.to, ...message.cc].every((person) => person.email.endsWith(`@${MAIL_DOMAIN}`));
  const key = thread.map((item) => item.id).join(":");
  const brief = state.data.briefs?.[key];
  const inTrash = message.folder === "trash";
  const close = () => { state.selected = null;  };
  const thread_ = (action) => { close(); threadAct([message.threadId], action); };
  return el("section", { class: "reader" }, [
    el("div", { class: "tools" }, [
      el("button", { class: "icon", "aria-label": `Back to ${state.box}`, title: `Back to ${state.box}`, onClick: () => { close(); render(); } }, ["←"]),
      message.system ? none() : el("button", { class: "quiet", onClick: () => reply(message) }, ["Reply"]),
      el("button", { class: "quiet", title: "Hide until 08:00 UTC tomorrow", onClick: () => { state.selected = null; state.box = "snoozed"; threadAct([message.threadId], "snooze"); } }, ["Snooze"]),
      message.folder === "archive" || inTrash ? el("button", { class: "quiet", onClick: () => thread_("inbox") }, ["Move to inbox"]) : el("button", { class: "quiet", title: "Archive (e)", onClick: () => thread_("archive") }, ["Archive"]),
      inTrash
        ? el("button", { class: "quiet danger", onClick: () => { if (confirm("Delete this message forever?")) act(async () => { await api("/api/remove", { id: message.id }); close(); }); } }, ["Delete forever"])
        : el("button", { class: "quiet", title: "Move to Trash (#)", onClick: () => thread_("trash") }, ["Trash"]),
      el("button", { class: "quiet", title: "Mark as unread (Shift + u)", onClick: () => thread_("unread") }, ["Mark unread"]),
      message.system || mine(message) ? none() : el("button", { class: "quiet", onClick: () => { if (confirm(`Send future mail from ${message.from.email} to Archive?`)) act(async () => { await api("/api/clean/mute", { email: message.from.email }); close(); }); } }, ["Mute sender"]),
      el("button", { class: "quiet", onClick: () => act(async () => { await api("/api/task", { title: message.subject, detail: "Queued from mail · waiting on you", messageId: message.id }); state.view = "tasks"; }) }, ["Architect"]),
      message.system ? none() : el("button", { class: "quiet", onClick: () => briefThread(message, key) }, [state.busy === key ? "Briefing…" : "Brief with SCALVS"]),
    ]),
    el("div", { class: "sheet" }, [
      el("h1", {}, [message.subject || "(no subject)"]),
      el("div", { class: "meta" }, [
        message.tunnel
          ? el("span", { class: "lock", title: `Sender key ${message.tunnel.fingerprint}` }, [message.tunnel.verified ? "🔒 Cumulus Tunnel · sealed and sender verified" : "🔒 Cumulus Tunnel · sealed"])
          : el("span", {}, [e2e ? "Inside Cumulus" : "Encrypted at rest · leaves Cumulus when delivered"]),
        ...(message.delivery || []).map((hop) => el("span", { class: hop.status === "bounced" ? "danger" : "" }, [`${hop.email} · ${hop.status === "inside" ? "delivered" : hop.status === "bounced" ? "not delivered" : "sent out"}`])),
      ]),
      brief ? el("div", { class: "brief" }, [brief]) : none(),
      state.error ? el("p", { class: "error", role: "alert" }, [state.error]) : none(),
      ...thread.map((item) => el("article", { class: "msg" }, [
        el("div", { class: "from" }, [
          el("div", {}, [el("strong", {}, [item.from.name]), el("span", { class: "sub" }, [`  ${item.from.email}`]), item.system ? el("span", { class: "tag" }, ["Account notice"]) : none()]),
          el("span", { class: "sub" }, [shortDate(item.at)]),
        ]),
        item.payment ? paymentCard(item) : none(),
        el("p", { class: "letter", translate: "no" }, [item.body]),
        ...(item.attachments || []).map((file) => file.id
          ? el("a", { class: "file", href: fileUrl(file.id), download: file.name, title: `Download ${file.name}` }, [file.name, el("span", { class: "sub" }, [size(file.size)])])
          : el("span", { class: "file", title: "This file wasn't stored, so it can't be opened." }, [file.name, el("span", { class: "sub" }, [size(file.size)])])),
      ])),
      state.composer?.inline ? el("div", { class: "inline-composer" }, [composerForm()]) : none(),
    ]),
  ]);
}

function reply(message) {
  state.error = "";
  state.composer = blankComposer({
    inline: true,
    threadId: message.threadId,
    to: mine(message) ? message.to.map((p) => p.email).join(", ") : message.from.email,
    subject: message.subject.startsWith("Re:") ? message.subject : `Re: ${message.subject}`,
    body: `\n\n—\n${message.from.name} wrote:\n${message.body.split("\n").map((line) => `> ${line}`).join("\n")}`,
  });
  render();
  document.querySelector(".inline-composer textarea")?.focus();
}

async function briefThread(message, key) {
  state.busy = key;
  render();
  await act(async () => {
    const result = await api("/api/brief", { mode: "summary", threadId: message.threadId, subject: message.subject });
    state.data.briefs = { ...state.data.briefs, [key]: result.text };
  });
  state.busy = "";
  render();
}

function composerForm() {
  const form = state.composer;
  form.payment ??= { asset: "USDC", amount: "" };
  const field = (label, key, attrs = {}) => el("label", { class: `field${key === "body" ? " body" : ""}` }, [
    key === "body" ? none() : el("span", {}, [label]),
    el(key === "body" ? "textarea" : "input", { "aria-label": label, value: form[key], ...attrs, onInput: (event) => { form[key] = event.target.value; queueDraftSave(); if (key === "to" || key === "cc") suggestFor(event.target); }, onBlur: (event) => { if (key === "to" || key === "cc") event.target.closest(".field")?.querySelector(".suggestions")?.remove(); } }),
  ]);
  const asset = el("select", { "aria-label": "Asset", onChange: (event) => { form.payment.asset = event.target.value; } }, ["USDC", "FIRM"].map((a) => el("option", { value: a }, [a])));
  asset.value = form.payment.asset;
  return el("form", { class: "composer", onSubmit: async (event) => { event.preventDefault(); await send(); } }, [
    field("To", "to", { autocomplete: "email" }),
    form.inline ? none() : field("Cc", "cc"),
    form.inline ? none() : field("Subject", "subject"),
    el("label", { class: "field" }, [
      el("span", {}, ["Pay"]),
      el("input", { inputmode: "decimal", placeholder: "Optional", "aria-label": "Amount to send", value: form.payment.amount, onInput: (event) => { form.payment.amount = event.target.value.trim(); } }),
      asset,
    ]),
    field("Message", "body"),
    ...(form.attachments || []).map((file, index) => el("span", { class: "file" }, [
      file.name, el("span", { class: "sub" }, [file.uploading ? "Uploading…" : size(file.size)]),
      el("button", { type: "button", "aria-label": `Remove ${file.name}`, onClick: () => { form.attachments.splice(index, 1); render(); } }, ["×"]),
    ])),
    el("div", { class: "actions" }, [
      el("span", { class: "send-group" }, [
        el("button", { class: "primary", type: "submit" }, ["Send"]),
        el("button", { class: "primary later", type: "button", "aria-label": "Schedule send", title: "Schedule send", "aria-expanded": Boolean(form.later), onClick: () => { form.later = !form.later; render(); } }, ["▾"]),
      ]),
      el("button", { class: "quiet", type: "button", onClick: () => filePicker.click() }, ["Attach"]),
      el("span", { class: "spacer" }),
      el("span", { class: "sub save-status", "aria-live": "polite" }, [form.draftId ? "Draft saved" : ""]),
      el("button", { class: "quiet", type: "button", title: "Delete this draft", onClick: () => discardComposer() }, ["Discard"]),
      state.error ? el("span", { class: "error", role: "alert" }, [state.error]) : none(),
    ]),
    form.later ? el("div", { class: "later-menu", role: "menu", "aria-label": "Schedule send" }, [
      el("p", { class: "sub" }, ["Schedule send"]),
      ...laterChoices().map(([label, at]) => el("button", { type: "button", role: "menuitem", onClick: () => scheduleSend(at) }, [el("span", {}, [label]), el("span", { class: "sub" }, [longDate(at.toISOString())])])),
      el("div", { class: "pick-time" }, [
        el("input", { type: "datetime-local", "aria-label": "Pick date and time", onChange: (e) => { form.laterAt = e.target.value; } }),
        el("button", { type: "button", class: "outline", onClick: () => scheduleSend(form.laterAt) }, ["Schedule"]),
      ]),
    ]) : none(),
    filePicker,
  ]);
}

const fileUrl = (id) => `/api/files/${id.split("/").map(encodeURIComponent).join("/")}`;

/** Upload a picked file to Cumulus storage; the composer keeps only the stored file's reference. */
async function uploadFile(form, file) {
  const entry = { name: file.name, size: file.size, uploading: true };
  form.attachments = [...(form.attachments || []), entry];
  render();
  try {
    const response = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "x-cumulus": "1" },
      body: file,
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Upload failed");
    const index = form.attachments.indexOf(entry);
    if (index >= 0) form.attachments.splice(index, 1, payload);
  } catch (err) {
    form.attachments = form.attachments.filter((a) => a !== entry);
    state.error = `${file.name}: ${err.message}`;
  }
  render();
  queueDraftSave();
}

const filePicker = el("input", { type: "file", multiple: true, style: "display:none", onChange: (event) => {
  const picked = [...(event.target.files || [])];
  event.target.value = "";
  if (!picked.length || !state.composer) return;
  state.error = "";
  for (const file of picked) {
    if (file.size > 25 * 1024 * 1024) { state.error = `${file.name} is over 25 MB. Larger files belong in Cloud.`; render(); continue; }
    uploadFile(state.composer, file);
  }
} });

const stillUploading = (form) => (form.attachments || []).some((a) => a.uploading);

/* Drafts save themselves a moment after you stop typing, like Gmail. */
let draftTimer;
let draftSaving = null;
const hasContent = (form) => Boolean(form && (form.to.trim() || form.subject.trim() || form.body.trim() || form.attachments?.length));
const saveStatus = (text) => { const node = document.querySelector(".save-status"); if (node) node.textContent = text; };

function queueDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraftNow(), 1500);
}

async function saveDraftNow() {
  clearTimeout(draftTimer);
  const form = state.composer;
  if (!hasContent(form)) return;
  if (draftSaving) await draftSaving;
  if (form.sent) return;
  saveStatus("Saving…");
  draftSaving = api("/api/draft", { ...form, payment: undefined })
    .then((r) => { form.draftId = r.id; saveStatus("Draft saved"); })
    .catch(() => saveStatus("Couldn't save the draft"))
    .finally(() => { draftSaving = null; });
  await draftSaving;
}

async function closeComposer() {
  const form = state.composer;
  if (hasContent(form)) await saveDraftNow();
  state.composer = null;
  state.error = "";
  if (form?.draftId) showToast("Draft saved to Drafts.");
  render();
}

async function discardComposer() {
  clearTimeout(draftTimer);
  if (draftSaving) await draftSaving;
  const form = state.composer;
  if (!form) return;
  form.sent = true;
  state.composer = null;
  await act(async () => {
    if (form.draftId) await api("/api/move", { id: form.draftId, folder: "trash" });
    showToast("Draft discarded.");
  });
}

window.addEventListener("beforeunload", () => {
  const form = state.composer;
  if (!hasContent(form) || form.sent) return;
  fetch("/api/draft", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json", "x-cumulus": "1" }, body: JSON.stringify({ ...form, payment: undefined }) });
});

async function send() {
  clearTimeout(draftTimer);
  if (draftSaving) await draftSaving;
  const form = state.composer;
  if (stillUploading(form)) { state.error = "Wait for your files to finish uploading."; render(); return; }
  const paying = Boolean(form.payment?.amount);
  if (paying && !confirm(`Send ${form.payment.amount} ${form.payment.asset} from your FIRM Wallet to ${form.to}?`)) return;
  try {
    form.sent = true;
    const result = await api("/api/send", { ...form, payment: paying ? form.payment : undefined });
    state.composer = null;
    state.error = result.bounced?.length ? `Not delivered to ${result.bounced.join(", ")}` : "";
    state.box = "sent";
    state.view = "mail";
    state.selected = result.id;
  } catch (error) {
    form.sent = false;
    state.error = error.message;
  }
  render();
}

function modal() {
  return el("div", { class: "scrim", onClick: (event) => { if (event.target === event.currentTarget) closeComposer(); } }, [
    el("div", { class: "dialog", role: "dialog", "aria-label": "New message" }, [
      el("div", { class: "dialog-head" }, [el("h2", {}, [state.composer.draftId ? "Draft" : "New message"]), el("button", { class: "quiet", "aria-label": "Save and close", title: "Save and close", onClick: () => closeComposer() }, ["×"])]),
      composerForm(),
    ]),
  ]);
}

/* ---------------- SCALVS Clean ---------------- */

async function loadClean() {
  await act(async () => { state.clean = await api("/api/clean"); });
}

const DAY_CHOICES = [null, 1, 3, 7, 14, 30, 90];
const dayLabel = (d) => (d === null ? "Off" : d === 1 ? "After 1 day" : `After ${d} days`);
const ago = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return shortDate(iso);
};

function cleanView() {
  const c = state.clean;
  if (!c) return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [el("p", { class: "muted" }, ["Loading…"])])]);
  const waiting = c.preview.reduce((n, a) => n + a.count, 0);
  const rule = (label, hint, key) => {
    const select = el("select", { "aria-label": label, onChange: (e) => act(() => api("/api/clean/rules", { [key]: e.target.value === "off" ? null : Number(e.target.value) })) },
      DAY_CHOICES.map((d) => el("option", { value: d === null ? "off" : String(d) }, [dayLabel(d)])));
    select.value = c.rules[key] === null ? "off" : String(c.rules[key]);
    if (!DAY_CHOICES.includes(c.rules[key])) select.prepend(el("option", { value: String(c.rules[key]), selected: true }, [dayLabel(c.rules[key])]));
    return el("div", { class: "rule" }, [el("div", {}, [el("div", {}, [label]), el("div", { class: "sub" }, [hint])]), select]);
  };
  const by = { rules: "Automatic", scalvs: "SCALVS", you: "You" };
  return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [
    el("h1", {}, [waiting ? `${waiting} message${waiting === 1 ? "" : "s"} ready to clean` : "Your inbox is clean"]),
    el("p", { class: "muted" }, [c.rules.auto ? `SCALVS cleans on its own${c.lastRun ? ` · last run ${ago(c.lastRun)}` : ""}. Everything it moves can be undone.` : "Automatic cleaning is off."]),
    el("div", { class: "actions" }, [
      el("button", { class: "primary", disabled: !waiting, onClick: () => act(() => api("/api/clean/run", {})) }, ["Clean now"]),
      el("button", { class: "outline", onClick: async () => { state.busy = "scalvs"; render(); await act(() => api("/api/clean/scalvs", {})); state.busy = ""; render(); } }, [state.busy === "scalvs" ? "SCALVS is reading…" : "Ask SCALVS"]),
    ]),
    state.error ? el("p", { class: "error", role: "alert" }, [state.error]) : none(),
    ...c.preview.map((a) => el("p", { class: "sub" }, [`${a.kind === "archive" ? "Archive" : a.kind === "trash" ? "Trash" : "Delete forever"} · ${a.reason}`])),

    el("div", { class: "stat-row" }, [
      ["person", "From people"], ["newsletter", "Newsletters"], ["notification", "Notices"], ["receipt", "Receipts"],
    ].map(([k, label]) => el("div", { class: "stat" }, [el("b", {}, [String(c.mix[k] ?? 0)]), el("span", {}, [label])]))),

    ...(c.suggestions.length || c.note ? [el("h3", {}, ["Suggestions"])] : []),
    c.note ? el("p", { class: "muted" }, [c.note]) : none(),
    ...c.suggestions.map((s) => el("div", { class: "suggest" }, [
      el("div", {}, [
        el("div", { class: "by" }, [s.source === "scalvs" ? "SCALVS" : "Rules"]),
        el("div", {}, [s.reason]),
        el("div", { class: "sub" }, [s.kind === "mute" ? `Mute ${s.email}` : `${s.kind === "trash" ? "Move to Trash" : "Archive"} · ${s.count} message${s.count === 1 ? "" : "s"}`]),
      ]),
      el("div", { class: "btns" }, [
        el("button", { class: "primary", onClick: () => act(() => api("/api/clean/approve", { id: s.id })) }, ["Approve"]),
        el("button", { class: "quiet", onClick: () => act(() => api("/api/clean/dismiss", { id: s.id })) }, ["Dismiss"]),
      ]),
    ])),

    el("h3", {}, ["Rules"]),
    el("div", { class: "rule" }, [
      el("div", {}, [el("div", {}, ["Clean automatically"]), el("div", { class: "sub" }, ["Runs when you open Mail, at most once an hour."])]),
      el("button", { class: "switch", role: "switch", "aria-checked": String(c.rules.auto), "aria-label": "Clean automatically", onClick: () => act(() => api("/api/clean/rules", { auto: !c.rules.auto })) }),
    ]),
    rule("Archive read newsletters", "Promotions, digests and mailing lists.", "newslettersAfterDays"),
    rule("Archive read notices", "Cloud shares and account notices you've seen. Security notices stay.", "notificationsAfterDays"),
    rule("Trash delivery failures", "Bounce notices from Mail Delivery.", "bouncesAfterDays"),
    rule("Empty Trash", "Deletes forever. This one can't be undone.", "emptyTrashAfterDays"),
    el("p", { class: "sub" }, ["Never moved automatically: starred mail, unread mail from people, payments, security notices, drafts and sent mail."]),

    ...(c.senders.length || c.rules.muted.length ? [el("h3", {}, ["Senders"])] : []),
    ...c.senders.map((s) => el("div", { class: "item" }, [
      el("div", {}, [el("div", {}, [s.name]), el("div", { class: "sub" }, [`${s.email} · ${s.count} message${s.count === 1 ? "" : "s"}`])]),
      el("button", { class: "outline", onClick: () => act(() => api("/api/clean/mute", { email: s.email })) }, ["Mute"]),
    ])),
    ...c.rules.muted.map((email) => el("div", { class: "item" }, [
      el("div", {}, [el("div", {}, [email]), el("div", { class: "sub" }, ["Muted · new mail goes to Archive"])]),
      el("button", { class: "quiet", onClick: () => act(() => api("/api/clean/unmute", { email })) }, ["Unmute"]),
    ])),

    ...(c.log.length ? [el("h3", {}, ["Activity"])] : []),
    ...c.log.map((e) => el("div", { class: "item" }, [
      el("div", {}, [el("div", {}, [e.reason]), el("div", { class: "sub" }, [`${by[e.by]} · ${e.kind === "archive" ? "archived" : e.kind === "trash" ? "trashed" : "deleted"} ${e.count} · ${ago(e.at)}${e.undone ? " · undone" : ""}`])]),
      e.kind !== "delete" && !e.undone ? el("button", { class: "quiet", onClick: () => act(() => api("/api/clean/undo", { id: e.id })) }, ["Undo"]) : none(),
    ])),
  ])]);
}

/* ---------------- FIRM Wallet ---------------- */

async function loadWallet() {
  await act(async () => { state.wallet = await api("/api/wallet"); });
}

function walletView() {
  const w = state.wallet;
  if (!w) return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [el("p", { class: "muted" }, ["Loading your FIRM Wallet…"])])]);
  const form = { to: "", asset: "USDC", amount: "", memo: "" };
  const input = (label, key, attrs = {}) => el("label", { class: "field" }, [el("span", {}, [label]), el("input", { "aria-label": label, ...attrs, onInput: (event) => { form[key] = event.target.value.trim(); } })]);
  const asset = el("select", { "aria-label": "Asset", onChange: (event) => { form.asset = event.target.value; } }, ["USDC", "FIRM"].map((a) => el("option", { value: a }, [a])));
  return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [
    el("firm-suite", { product: "cumulus-mail", wallet: JSON.stringify({ address: w.address, balances: w.balances }) }),
    el("form", { class: "wallet-form", onSubmit: (event) => {
      event.preventDefault();
      if (!form.to || !form.amount) { state.error = "Add who to pay and how much."; render(); return; }
      if (!confirm(`Send ${form.amount} ${form.asset} to ${form.to}?`)) return;
      act(async () => { await api("/api/wallet/pay", form); state.wallet = await api("/api/wallet"); });
    } }, [
      input("To", "to", { placeholder: `name@${MAIL_DOMAIN} or 0x…` }),
      el("label", { class: "field" }, [el("span", {}, ["Amount"]), el("input", { "aria-label": "Amount", inputmode: "decimal", placeholder: "0.00", onInput: (event) => { form.amount = event.target.value.trim(); } }), asset]),
      input("Note", "memo", { placeholder: "Optional" }),
      el("div", { class: "actions" }, [el("button", { class: "primary", type: "submit" }, ["Send"]), state.error ? el("span", { class: "error", role: "alert" }, [state.error]) : none()]),
    ]),
    el("h3", {}, ["Activity"]),
    ...(w.history.length
      ? w.history.map((t) => el("div", { class: "item" }, [
          el("div", {}, [el("div", {}, [`${t.direction === "in" ? "From" : "To"} ${t.counterparty}`]), el("div", { class: "sub" }, [`${t.memo ? `${t.memo} · ` : ""}${shortDate(t.at)}`])]),
          el("strong", { class: t.direction === "in" ? "lock" : "" }, [`${t.direction === "in" ? "+" : "−"}${t.amount} ${t.asset}`]),
        ]))
      : [el("p", { class: "muted" }, ["No activity yet. Money you send or receive by mail shows up here too."])]),
  ])]);
}

function aux(data) {
  if (state.view === "wallet") return walletView();
  if (state.view === "clean") return cleanView();
  if (state.view === "contacts") {
    return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [el("h1", {}, ["People"]), ...(data.contacts.length ? data.contacts.map((contact) => el("div", { class: "item" }, [
      el("div", {}, [el("div", {}, [contact.name]), el("div", { class: "sub" }, [contact.email]), contact.note ? el("div", { class: "sub" }, [contact.note]) : none()]),
      el("button", { class: "outline", onClick: () => { state.composer = blankComposer({ to: contact.email }); state.view = "mail"; render(); } }, ["Write"]),
    ])) : [el("p", { class: "muted" }, ["No contacts yet."])])])]);
  }
  if (state.view === "tasks") {
    return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [el("h1", {}, ["Waiting on you"]), ...(data.tasks.length ? data.tasks.map((task) => el("div", { class: "item" }, [
      el("div", {}, [el("div", { class: task.done ? "muted" : "" }, [task.title]), el("div", { class: "sub" }, [task.detail])]),
      el("button", { class: "quiet", onClick: () => act(() => api("/api/task/toggle", { id: task.id })) }, [task.done ? "Reopen" : "Done"]),
    ])) : [el("p", { class: "muted" }, ["Nothing queued. Send any thread to Architect from the message toolbar."])])])]);
  }
  const a = data.account;
  return el("section", { class: "pane" }, [el("div", { class: "sheet" }, [
    el("h1", {}, [data.me.name]),
    el("p", { class: "sub" }, ["Your Cumulus://ID"]),
    el("p", { class: "big" }, [data.me.email]),
    el("p", { class: "muted" }, ["One address for every Infinitum product. Sign in to +SPCTR, Cloud and the FIRM Wallet with it."]),
    el("h3", {}, ["Aliases"]),
    ...(data.aliases.length ? data.aliases.map((alias) => el("p", { class: "mono" }, [alias])) : [el("p", { class: "muted" }, ["No aliases yet."])]),
    el("button", { class: "outline", onClick: () => act(async () => {
      const words = ["north", "quiet", "glass", "harbor", "lumen"];
      const pick = () => words[Math.floor(Math.random() * words.length)];
      await api("/api/alias", { alias: `${pick()}.${pick()}.${1000 + Math.floor(Math.random() * 9000)}@${MAIL_DOMAIN}` });
    }) }, ["New disposable alias"]),
    el("h3", {}, [`${a.plan} plan · included with your Cumulus://ID`]),
    el("ul", { class: "plan" }, [
      el("li", {}, [`Mail · ${a.mailAddress}`]),
      el("li", {}, [`Cloud · ${a.storage.label} (Mail ${a.storage.mail}, Cloud ${a.storage.cloud})`]),
      el("li", {}, ["FIRM Wallet"]),
      el("li", {}, ["SCALVS Clean, SCALVS.ai and :\\ARCHITECT\\"]),
    ]),
    el("h3", {}, ["Cumulus Tunnel"]),
    el("p", {}, ["Mail between Cumulus accounts is sealed to the recipient and signed by the sender. Your keys were made for you when your Cumulus://ID was created. There's nothing to set up or remember."]),
    data.tunnel?.fingerprint ? el("p", { class: "sub" }, ["Your key fingerprint"]) : none(),
    data.tunnel?.fingerprint ? el("p", { class: "mono" }, [data.tunnel.fingerprint]) : none(),
    el("p", { class: "muted" }, [data.tunnel?.atRest ? "Your mailbox is stored encrypted. Never scanned for ads and never sold." : "Never scanned for ads and never sold."]),
    el("div", { class: "actions" }, [el("button", { class: "outline", onClick: async () => { await api("/api/auth/signout", {}); state.data = null; renderAuth(); } }, ["Sign out"])]),
  ])]);
}

/* ---------------- Cumulus://ID sign-in (passkeys) ---------------- */

const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function createPasskey(o) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64uToBuf(o.challenge),
    rp: o.rp,
    user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams,
    authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: o.excludeCredentials.map((c) => ({ type: "public-key", id: b64uToBuf(c.id) })),
    attestation: "none",
    timeout: o.timeout,
  } });
  return { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) };
}

async function usePasskey(o) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: b64uToBuf(o.challenge),
    rpId: o.rpId,
    allowCredentials: o.allowCredentials.map((c) => ({ type: "public-key", id: b64uToBuf(c.id) })),
    userVerification: o.userVerification,
    timeout: o.timeout,
  } });
  return {
    credentialId: bufToB64u(cred.rawId),
    clientDataJSON: bufToB64u(cred.response.clientDataJSON),
    authenticatorData: bufToB64u(cred.response.authenticatorData),
    signature: bufToB64u(cred.response.signature),
  };
}

async function finishSignIn(response) {
  const result = await api("/api/auth/signin/finish", { response });
  if (result.status === "mfa_required") {
    const code = prompt("Enter the 6-digit code from your authenticator app");
    if (!code) throw new Error("Sign-in needs your authenticator code.");
    await api("/api/auth/mfa", { mfaToken: result.mfaToken, code });
  }
  history.replaceState(null, "", "/");
  await boot();
}

function renderAuth(message = "") {
  
  const root = document.querySelector("#app");
  const err = el("p", { class: "error", role: "alert" }, [message]);
  const fail = (e) => { err.textContent = e.name === "NotAllowedError" ? "Passkey request was cancelled." : e.message; };
  const username = el("input", { placeholder: `name@${MAIL_DOMAIN}`, "aria-label": "Your new Cumulus://ID", autocomplete: "username webauthn", autocapitalize: "none", spellcheck: "false" });
  const social = el("div", { class: "social" });
  api("/api/auth/providers")
    .then((providers) => social.replaceChildren(...providers.map((p) => el("a", { class: "outline", href: `/api/auth/oauth/${encodeURIComponent(p.id)}/start` }, [`Continue with ${p.label}`]))))
    .catch(() => {});
  root.replaceChildren(el("div", { class: "auth" }, [el("div", { class: "auth-card" }, [
    el("div", { class: "mark" }, ["Cumulus://Mail", el("sup", { class: "tm" }, ["™"])]),
    el("p", { class: "muted" }, [state.signInFor ? `Sign in with your Cumulus://ID to continue to ${state.signInFor}` : "Sign in with your Cumulus://ID"]),
    el("button", { class: "primary", onClick: async () => {
      err.textContent = "";
      try {
        const { options } = await api("/api/auth/signin", {});
        await finishSignIn(await usePasskey(options));
      } catch (e) { fail(e); }
    } }, ["Continue with passkey"]),
    window.cumulusDesktop ? el("button", { class: "outline", onClick: () => {
      err.textContent = "";
      window.cumulusDesktop.signInWithBrowser().catch(fail);
      err.textContent = "Finish signing in in your browser, then come back here.";
    } }, ["Sign in with your browser"]) : null,
    social,
    el("p", { class: "muted divider" }, ["New here? Pick your address. It's your Cumulus://ID."]),
    username,
    el("button", { class: "outline", onClick: async () => {
      err.textContent = "";
      const name = username.value.trim();
      if (!name) { err.textContent = "Pick your address first."; return; }
      try {
        const { cid, options } = await api("/api/auth/signup", { username: name });
        const done = await api("/api/auth/signup/finish", { cid, response: await createPasskey(options) });
        await finishSignIn(await usePasskey(done.options));
      } catch (e) { fail(e); }
    } }, ["Create my Cumulus://ID"]),
    err,
    el("p", { class: "muted small" }, [`Your @${MAIL_DOMAIN} address is your Cumulus://ID. It comes with 15 GB shared with Cumulus://Cloud and a FIRM Wallet. Free.`]),
  ])]));
}

/* ---------------- Keyboard shortcuts and live refresh ---------------- */

let pendingG = false;
document.addEventListener("keydown", (e) => {
  if (!state.data || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
    if (e.key === "Escape") t.blur();
    return;
  }
  const open = state.data.messages.find((m) => m.id === state.selected);
  const current = open ?? state.visible?.[state.cursor];
  const go_ = (fn) => { e.preventDefault(); fn(); };
  if (pendingG) {
    pendingG = false;
    const to = { i: "inbox", s: "starred", t: "sent", d: "drafts", a: "archive" }[e.key];
    if (to) go_(() => { state.box = to; state.filter = "primary"; state.cursor = -1; go("mail"); });
    return;
  }
  switch (e.key) {
    case "?": return go_(() => { state.help = !state.help; render(); });
    case "Escape": if (state.help) return go_(() => { state.help = false; render(); }); return;
    case "c": return go_(() => { state.composer = blankComposer(); render(); document.querySelector(".dialog input")?.focus(); });
    case "/": return go_(() => document.querySelector(".search input")?.focus());
    case "g": pendingG = true; setTimeout(() => { pendingG = false; }, 1200); return;
    case "z": if (state.toast?.undo) return go_(() => undo(state.toast.undo)); return;
  }
  if (state.view !== "mail") return;
  const move = (d) => go_(() => {
    const n = state.visible?.length ?? 0;
    if (!n) return;
    state.cursor = Math.max(0, Math.min(n - 1, state.cursor + d));
    render();
    document.querySelector(`.row[data-index="${state.cursor}"]`)?.scrollIntoView({ block: "nearest" });
  });
  if (!open && (e.key === "j" || e.key === "ArrowDown")) return move(1);
  if (!open && (e.key === "k" || e.key === "ArrowUp")) return move(-1);
  if (!open && (e.key === "o" || e.key === "Enter") && current) return go_(() => openMessage(current));
  if (open && e.key === "u") return go_(() => { state.selected = null; render(); });
  if (!current) return;
  const targets = !open && state.picked.size ? [...state.picked] : [current.threadId];
  const leave = () => { if (open) state.selected = null; };
  if (e.key === "e" && current.folder === "inbox") return go_(() => { leave(); threadAct(targets, "archive"); });
  if (e.key === "#") return go_(() => { leave(); threadAct(targets, "trash"); });
  if (e.key === "I") return go_(() => threadAct(targets, "read"));
  if (e.key === "U") return go_(() => { leave(); threadAct(targets, "unread"); });
  if (e.key === "s") return go_(() => threadAct(targets, current.starred ? "unstar" : "star"));
  if (e.key === "x" && !open) return go_(() => { if (state.picked.has(current.threadId)) state.picked.delete(current.threadId); else state.picked.add(current.threadId); render(); });
  if (e.key === "r" && open && !open.system) return go_(() => reply(open));
});

async function refresh(manual = false) {
  if (!state.data) return;
  const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!manual && (document.hidden || state.composer || typing || state.view !== "mail")) return;
  const before = state.data.unread;
  try {
    state.data = { ...state.data, ...(await fetch("/api/state", { headers: { "x-cumulus": "1" }, credentials: "same-origin" }).then((r) => (r.ok ? r.json() : Promise.reject(r)))) };
  } catch {
    return;
  }
  if (!manual && state.data.unread > before) showToast(state.data.unread - before === 1 ? "New mail arrived." : `${state.data.unread - before} new conversations.`);
  render();
}
setInterval(() => refresh(), 30_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

/* Signing in the desktop app: the app opens /?desktop=<challenge> here; you approve, and the app gets a one-time code. */
const DESKTOP_KEY = "cumulus-desktop-challenge";
function takeDesktopChallenge() {
  const params = new URLSearchParams(location.search);
  const c = params.get("desktop");
  if (c && /^[A-Za-z0-9_-]{43}$/.test(c)) {
    try { sessionStorage.setItem(DESKTOP_KEY, c); } catch {}
    history.replaceState(null, "", "/");
  }
  try { return sessionStorage.getItem(DESKTOP_KEY); } catch { return null; }
}

function renderDesktopApprove(challenge) {
  const root = document.querySelector("#app");
  const err = el("p", { class: "error", role: "alert" }, []);
  const done = () => { try { sessionStorage.removeItem(DESKTOP_KEY); } catch {} };
  root.replaceChildren(el("div", { class: "auth" }, [el("div", { class: "auth-card" }, [
    el("div", { class: "mark" }, ["Cumulus://Mail", el("sup", { class: "tm" }, ["™"])]),
    el("p", {}, [`Sign in to the Cumulus://Mail desktop app as ${state.data?.me?.email ?? "you"}?`]),
    el("p", { class: "muted small" }, ["Only continue if you just clicked “Sign in with your browser” in the app on this computer."]),
    el("button", { class: "primary", onClick: async () => {
      err.textContent = "";
      try {
        const { code } = await api("/api/auth/desktop/grant", { challenge });
        done();
        location.href = `cumulus-mail://signin?code=${encodeURIComponent(code)}`;
        root.replaceChildren(el("div", { class: "auth" }, [el("div", { class: "auth-card" }, [
          el("div", { class: "mark" }, ["You're signed in"]),
          el("p", { class: "muted" }, ["Go back to the Cumulus://Mail app. You can close this tab."]),
          el("a", { class: "outline", href: "/" }, ["Open mail here instead"]),
        ])]));
      } catch (e) { err.textContent = e.message; }
    } }, ["Open the app"]),
    el("button", { class: "outline", onClick: () => { done(); render(); } }, ["Cancel"]),
    err,
  ])]));
}

/*
 * Coming from another Infinitum product ("Sign in with Cumulus://ID") or from Drive: /?next=<path>.
 * Only paths on this site are kept, and only the sign-in request and the Drive pages.
 */
const NEXT_KEY = "cumulus-next";
function takeNext() {
  const params = new URLSearchParams(location.search);
  const next = params.get("next");
  if (next && /^\/(api\/id\/authorize\?|drive\/)/.test(next) && !next.startsWith("//")) {
    try { sessionStorage.setItem(NEXT_KEY, JSON.stringify({ next, for: (params.get("for") || "").slice(0, 60) })); } catch {}
    history.replaceState(null, "", "/");
  }
  try { return JSON.parse(sessionStorage.getItem(NEXT_KEY) || "null"); } catch { return null; }
}

async function boot() {
  const desktopChallenge = takeDesktopChallenge();
  const pending = takeNext();
  state.signInFor = pending?.for || "";
  const [page, arg] = location.hash.replace(/^#\/?/, "").split("/");
  if (page === "signin-error") return renderAuth(decodeURIComponent(arg || ""));
  if (page === "mfa" && arg) {
    const code = prompt("Enter the 6-digit code from your authenticator app");
    history.replaceState(null, "", "/");
    if (code) {
      try { await api("/api/auth/mfa", { mfaToken: arg, code }); } catch (e) { return renderAuth(e.message); }
    }
  }
  try {
    state.data = await api("/api/state");
    if (pending) {
      try { sessionStorage.removeItem(NEXT_KEY); } catch {}
      location.replace(pending.next);
      return;
    }
    const params = new URLSearchParams(location.search);
    if (params.get("compose") === "1") state.composer = blankComposer({ to: (params.get("to") || "").slice(0, 2000), subject: (params.get("subject") || "").slice(0, 500), body: (params.get("body") || "").slice(0, 20000) });
    if (params.has("compose") || params.has("source")) history.replaceState(null, "", "/");
    if (desktopChallenge) return renderDesktopApprove(desktopChallenge);
    render();
  } catch {
    // Not signed in: renderAuth() has already been shown.
  }
}

boot();

/* Installable app: register the service worker, and open the composer from the "Compose" shortcut. */
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
