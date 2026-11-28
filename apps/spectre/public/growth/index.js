// +SPCTR Grow: conversations, forms, calendars and automations.
// Pages for the growth engine (src/core/forms.ts, calendar.ts, automations.ts, messaging.ts).
// They register with app.js through window.spctr and use its helpers and styles.

const S = window.spctr;
const { api, esc, date, ago, toast, main } = S;

const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const tagsIn = (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean);
const copyable = (label, value) => `<label class="field">${esc(label)}<div class="row"><input class="input" readonly value="${esc(value)}" data-copy><button type="button" class="btn small" data-copy-btn>Copy</button></div></label>`;
function wireCopy(el) {
  el.querySelectorAll("[data-copy-btn]").forEach((b) => b.onclick = async () => {
    const input = b.parentElement.querySelector("[data-copy]");
    input.select();
    try { await navigator.clipboard.writeText(input.value); toast("Copied"); } catch { document.execCommand?.("copy"); toast("Copied"); }
  });
}
async function act(fn, ok) {
  try { await fn(); if (ok) toast(ok); } catch (e) { toast(e.message); }
}
const contactsCache = { at: 0, list: [] };
async function contacts() {
  if (Date.now() - contactsCache.at > 15_000) contactsCache.list = (await api("GET", "/api/contacts")).filter((c) => !c.optedOut), contactsCache.at = Date.now();
  return contactsCache.list;
}

/** Adds a "Use a template" picker to a form with channel/subject/body fields. Fills them on pick. */
async function templatePicker(form) {
  const all = await api("GET", "/api/crm/templates").catch(() => []);
  if (!all.length || !form.body) return;
  const wrap = document.createElement("label");
  wrap.className = "field tpl-pick";
  wrap.innerHTML = `Use a template<select class="input small" name="template"><option value="">Choose…</option></select>`;
  (form.body.closest(".field") ?? form.body).before(wrap);
  const sel = wrap.querySelector("select");
  const fill = () => {
    const ch = form.channel?.value;
    const usable = all.filter((t) => !ch || ch === "note" || t.channel === ch);
    sel.innerHTML = `<option value="">Choose…</option>${usable.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}`;
    wrap.hidden = !usable.length;
  };
  fill();
  form.channel?.addEventListener("change", fill);
  sel.onchange = () => {
    const t = all.find((x) => x.id === sel.value);
    if (!t) return;
    if (form.body.value.trim() && !confirm("Replace what you've written with this template?")) { sel.value = ""; return; }
    form.body.value = t.body;
    if (form.subject && t.subject) form.subject.value = t.subject;
    form.body.dispatchEvent(new Event("input", { bubbles: true }));
    sel.value = "";
  };
}

/* ---------------- Conversations ---------------- */

async function renderInbox() {
  const id = S.route().id;
  const data = await api("GET", "/api/crm/conversations");
  const connected = data.providers.email || data.providers.sms;
  main().innerHTML = `
    <div class="page wide">
      <div class="page-head"><h1>Conversations</h1><button class="btn primary" id="new-msg">New message</button></div>
      ${connected ? "" : `<div class="notice">Email and SMS aren't connected on this host yet. Messages you write are kept on the contact's record as drafts.</div>`}
      <div class="inbox${id ? " open" : ""}">
        <div class="threads list">${data.threads.length ? data.threads.map((t) => `
          <a class="item${t.contactId === id ? " active" : ""}" href="#/inbox/${esc(t.contactId)}">
            <div class="avatar sm">${esc(S.initials(t.name))}</div>
            <div class="main"><div class="title">${esc(t.name)}${t.unread ? ` <span class="pill high">${t.unread}</span>` : ""}</div>
            <div class="sub">${t.last.direction === "in" ? "" : "You: "}${esc(t.last.preview)}</div></div>
            <div class="faint small">${ago(t.last.at)}</div>
          </a>`).join("") : `<div class="empty">No conversations yet. Start one with <b>New message</b>.</div>`}</div>
        <div class="thread-pane" id="thread">${id ? "" : `<div class="empty">Pick a conversation.</div>`}</div>
      </div>
    </div>`;
  S.$("#new-msg").onclick = newMessage;
  updateInboxBadge(data.threads);
  if (id) await renderThread(id, data.providers);
}

async function renderThread(contactId, providers) {
  const pane = S.$("#thread");
  const t = await api("GET", `/api/crm/conversations/${encodeURIComponent(contactId)}`);
  if (t.unread) api("POST", `/api/crm/conversations/${encodeURIComponent(contactId)}/read`, {}).then(() => updateInboxBadge()).catch(() => {});
  const channels = [["email", "Email", t.contact.email], ["sms", "SMS", t.contact.phone], ["note", "Internal note", true]].filter(([, , ok]) => ok);
  pane.innerHTML = `
    <div class="thread-head"><a href="#/inbox" class="btn ghost small back">‹</a><div><div class="title">${esc(t.contact.name)}</div>
      <div class="faint small">${[t.contact.email, t.contact.phone].filter(Boolean).map(esc).join(" · ") || "No email or phone on file"}</div></div></div>
    <div class="bubbles">${t.messages.map((m) => `
      <div class="bubble ${m.channel === "note" ? "note" : m.direction}">
        ${m.subject ? `<div class="subject">${esc(m.subject)}</div>` : ""}<div class="body">${esc(m.body)}</div>
        <div class="meta">${esc(m.channel)} · ${when(m.at)}${m.status !== "sent" && m.status !== "received" ? ` · ${esc(m.status)}` : ""}${m.error ? ` · ${esc(m.error)}` : ""}</div>
      </div>`).join("") || `<div class="empty">No messages yet.</div>`}</div>
    ${t.contact.optedOut ? `<div class="notice">This person opted out. +SPCTR™ won't send them messages.</div>` : `
    <form class="composer" id="compose">
      <div class="row"><select class="input small" name="channel">${channels.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <input class="input small" name="subject" placeholder="Subject" ${channels[0]?.[0] === "email" ? "" : "hidden"}></div>
      <textarea class="input" name="body" rows="3" required placeholder="Write a message… {{first_name}} works here"></textarea>
      <div class="row"><span class="faint small">${providers?.email || providers?.sms ? "" : "Saved as a draft until email/SMS is connected."}</span><button class="btn primary">Send</button></div>
    </form>`}`;
  pane.querySelector(".bubbles").scrollTop = 1e9;
  const form = S.$("#compose");
  if (!form) return;
  form.channel.onchange = () => { form.subject.hidden = form.channel.value !== "email"; };
  templatePicker(form);
  form.onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const m = await api("POST", `/api/crm/conversations/${encodeURIComponent(contactId)}`, { channel: form.channel.value, subject: form.subject.value || undefined, body: form.body.value });
      toast(m.status === "sent" ? "Sent" : m.status === "draft" ? "Saved as draft" : `Not sent: ${m.error || m.status}`);
      renderInbox();
    });
  };
}

async function newMessage() {
  const list = await contacts();
  S.modal(`<h2>New message</h2>
    <label class="field">To<select class="input" name="contactId" required>${list.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.email ? ` · ${esc(c.email)}` : c.phone ? ` · ${esc(c.phone)}` : ""}</option>`).join("")}</select></label>
    ${list.length ? "" : `<p class="faint small">Add a person first.</p>`}`, async (f) => {
    location.hash = `#/inbox/${encodeURIComponent(f.get("contactId"))}`;
  });
}

async function updateInboxBadge(threads) {
  try {
    threads ??= (await api("GET", "/api/crm/conversations")).threads;
    const n = threads.reduce((s, t) => s + t.unread, 0);
    const b = S.$("#inbox-badge");
    if (b) { b.textContent = String(n); b.classList.toggle("hidden", !n); }
  } catch { /* signed out */ }
}

/* ---------------- Forms ---------------- */

const FIELD_TYPES = [["text", "Short text"], ["email", "Email"], ["phone", "Phone"], ["textarea", "Long text"], ["select", "Dropdown"]];
const MAPS = [["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["title", "Job title"], ["company", "Company"], ["field", "Custom field"]];
const keyOf = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "field";

async function renderForms() {
  const id = S.route().id;
  if (id) return renderFormDetail(id);
  const forms = await api("GET", "/api/crm/forms");
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Forms</h1><button class="btn primary" id="new-form">New form</button></div>
      <p class="muted">Capture leads on any website. Each answer lands on the person's record, with tags and automations.</p>
      ${forms.length ? `<div class="list">${forms.map((f) => `
        <a class="item" href="#/forms/${esc(f.id)}">
          <div class="main"><div class="title">${esc(f.name)}${f.active ? "" : ` <span class="pill">paused</span>`}</div>
          <div class="sub">${f.fields.length} fields · ${f.submissions} submission${f.submissions === 1 ? "" : "s"}${f.lastSubmission ? ` · last ${ago(f.lastSubmission)}` : ""}</div></div>
        </a>`).join("")}</div>` : `<div class="empty">No forms yet. A contact form takes a minute.</div>`}
    </div>`;
  S.$("#new-form").onclick = () => formEditor();
}

function fieldRow(f = { label: "", type: "text", map: "field", required: false }) {
  const map = f.map?.startsWith?.("field:") ? "field" : f.map || "field";
  return `<div class="field-row">
    <input class="input small" name="label" placeholder="Question" value="${esc(f.label)}" required>
    <select class="input small" name="type">${FIELD_TYPES.map(([v, l]) => `<option value="${v}" ${v === f.type ? "selected" : ""}>${l}</option>`).join("")}</select>
    <select class="input small" name="map" aria-label="Saves to">${MAPS.map(([v, l]) => `<option value="${v}" ${v === map ? "selected" : ""}>${l}</option>`).join("")}</select>
    <input class="input small" name="options" placeholder="Options, comma separated" value="${esc((f.options || []).join(", "))}" ${f.type === "select" ? "" : "hidden"}>
    <label class="check"><input type="checkbox" name="required" ${f.required ? "checked" : ""}>Required</label>
    <button type="button" class="btn ghost small" data-remove aria-label="Remove">✕</button>
  </div>`;
}

function formEditor(existing) {
  const fields = existing?.fields ?? [
    { label: "Name", type: "text", map: "name", required: true },
    { label: "Email", type: "email", map: "email", required: true },
    { label: "Phone", type: "phone", map: "phone" },
    { label: "How can we help?", type: "textarea", map: "field" },
  ];
  S.modal(`<h2>${existing ? "Edit form" : "New form"}</h2>
    <label class="field">Name<input class="input" name="name" required value="${esc(existing?.name ?? "")}" placeholder="Contact us"></label>
    <label class="field">Headline<input class="input" name="headline" value="${esc(existing?.headline ?? "")}" placeholder="Talk to our team"></label>
    <div class="field">Questions<div id="field-rows">${fields.map(fieldRow).join("")}</div>
      <button type="button" class="btn small" id="add-field">Add question</button></div>
    <div class="grid2">
      <label class="field">Tags to add<input class="input" name="tags" value="${esc((existing?.tags ?? ["website"]).join(", "))}"></label>
      <label class="field">Thank-you message<input class="input" name="successMessage" value="${esc(existing?.successMessage ?? "Thanks! We'll be in touch soon.")}"></label>
    </div>`, async (f) => {
    const rows = [...document.querySelectorAll("#field-rows .field-row")];
    const used = new Set();
    const out = rows.map((r) => {
      const label = r.querySelector("[name=label]").value.trim();
      let key = keyOf(label);
      while (used.has(key)) key += "_2";
      used.add(key);
      const m = r.querySelector("[name=map]").value;
      const type = r.querySelector("[name=type]").value;
      return { key, label, type, required: r.querySelector("[name=required]").checked, map: m === "field" ? `field:${key}` : m,
        ...(type === "select" ? { options: tagsIn(r.querySelector("[name=options]").value) } : {}) };
    });
    const body = { name: f.get("name"), headline: f.get("headline") || undefined, fields: out, tags: tagsIn(f.get("tags")), successMessage: f.get("successMessage") };
    const saved = existing ? await api("PATCH", `/api/crm/forms/${existing.id}`, body) : await api("POST", "/api/crm/forms", body);
    toast(existing ? "Form saved" : "Form created");
    location.hash = `#/forms/${saved.id}`;
    if (existing) renderForms();
  });
  const rows = S.$("#field-rows");
  const wire = () => rows.querySelectorAll(".field-row").forEach((r) => {
    r.querySelector("[data-remove]").onclick = () => r.remove();
    r.querySelector("[name=type]").onchange = (e) => { r.querySelector("[name=options]").hidden = e.target.value !== "select"; };
  });
  wire();
  S.$("#add-field").onclick = () => { rows.insertAdjacentHTML("beforeend", fieldRow()); wire(); };
}

async function renderFormDetail(id) {
  const [forms, subs] = await Promise.all([api("GET", "/api/crm/forms"), api("GET", `/api/crm/forms/${encodeURIComponent(id)}/submissions`)]);
  const f = forms.find((x) => x.id === id);
  if (!f) throw new Error("Form not found");
  const link = `${location.origin}/form.html?f=${encodeURIComponent(f.id)}`;
  const keys = f.fields.map((x) => x.key);
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${esc(f.name)}</h1><div class="row">
        <a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Preview</a>
        <button class="btn" id="toggle">${f.active ? "Pause" : "Resume"}</button>
        <button class="btn primary" id="edit">Edit</button></div></div>
      <a class="faint small" href="#/forms">‹ All forms</a>
      <div class="section"><h2>Share</h2>
        ${copyable("Link", link)}
        ${copyable("Button for your site", `<a href="${link}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 20px;background:#111820;color:#fff;text-decoration:none;font:500 15px system-ui,sans-serif">${f.headline || f.name}</a>`)}
        <p class="faint small">Paste the button into any page. The form opens on its own page (it can't be framed inside other sites).</p>
      </div>
      <div class="section"><h2>Submissions <span class="faint">(${f.submissions})</span></h2>
        ${subs.length ? `<div class="table-wrap"><table class="simple"><thead><tr><th>When</th>${f.fields.map((x) => `<th>${esc(x.label)}</th>`).join("")}</tr></thead>
        <tbody>${subs.map((s) => `<tr><td class="nowrap">${when(s.at)}</td>${keys.map((k) => `<td>${esc(s.answers?.[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
        : `<div class="empty">No submissions yet. Share the link to start collecting leads.</div>`}
      </div>
    </div>`;
  wireCopy(main());
  S.$("#edit").onclick = () => formEditor(f);
  S.$("#toggle").onclick = () => act(async () => { await api("PATCH", `/api/crm/forms/${f.id}`, { active: !f.active }); renderFormDetail(id); }, f.active ? "Form paused" : "Form live");
}

/* ---------------- Calendars ---------------- */

const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];

async function renderCalendars() {
  const [cals, appts] = await Promise.all([api("GET", "/api/crm/calendars"), api("GET", "/api/crm/appointments")]);
  const people = new Map((await contacts().catch(() => [])).map((c) => [c.id, c.name]));
  const calName = new Map(cals.map((c) => [c.id, c.name]));
  const upcoming = appts.filter((a) => a.status === "booked");
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Calendars</h1><button class="btn primary" id="new-cal">New calendar</button></div>
      <p class="muted">Let people book time with you. Each booking adds the person, tags them, and starts any automations.</p>
      ${cals.length ? `<div class="list">${cals.map((c) => {
        const link = `${location.origin}/book.html?c=${encodeURIComponent(c.id)}`;
        return `<div class="item cal">
          <div class="main"><div class="title">${esc(c.name)}${c.active ? "" : ` <span class="pill">paused</span>`}</div>
          <div class="sub">${c.durationMin} min · ${esc(c.timezone)} · ${DAYS.filter(([d]) => c.availability?.[d]?.length).map(([, l]) => l).join(", ") || "no hours set"}</div>
          ${copyable("Booking link", link)}</div>
          <div class="row"><button class="btn small" data-edit="${esc(c.id)}">Edit</button><button class="btn small" data-toggle="${esc(c.id)}">${c.active ? "Pause" : "Resume"}</button></div>
        </div>`; }).join("")}</div>` : `<div class="empty">No calendars yet.</div>`}
      <div class="section"><h2>Upcoming appointments</h2>
        ${upcoming.length ? `<div class="list">${upcoming.map((a) => `
          <div class="item"><div class="main"><div class="title">${esc(people.get(a.contactId) ?? "Someone")}</div>
            <div class="sub">${when(a.start)} · ${esc(calName.get(a.calendarId) ?? "")}${a.notes ? ` · ${esc(a.notes)}` : ""}</div></div>
            <button class="btn small ghost" data-cancel="${esc(a.id)}">Cancel</button></div>`).join("")}</div>` : `<div class="empty">Nothing booked yet.</div>`}
      </div>
    </div>`;
  wireCopy(main());
  S.$("#new-cal").onclick = () => calendarEditor();
  main().querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => calendarEditor(cals.find((c) => c.id === b.dataset.edit)));
  main().querySelectorAll("[data-toggle]").forEach((b) => b.onclick = () => act(async () => {
    const c = cals.find((x) => x.id === b.dataset.toggle);
    await api("PATCH", `/api/crm/calendars/${c.id}`, { active: !c.active });
    renderCalendars();
  }));
  main().querySelectorAll("[data-cancel]").forEach((b) => b.onclick = () => {
    if (!confirm("Cancel this appointment?")) return;
    act(async () => { await api("POST", `/api/crm/appointments/${b.dataset.cancel}/cancel`, {}); renderCalendars(); }, "Appointment cancelled");
  });
}

function calendarEditor(existing) {
  const tz = existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const av = existing?.availability ?? { 1: [{ start: "09:00", end: "17:00" }], 2: [{ start: "09:00", end: "17:00" }], 3: [{ start: "09:00", end: "17:00" }], 4: [{ start: "09:00", end: "17:00" }], 5: [{ start: "09:00", end: "17:00" }] };
  S.modal(`<h2>${existing ? "Edit calendar" : "New calendar"}</h2>
    <label class="field">Name<input class="input" name="name" required value="${esc(existing?.name ?? "")}" placeholder="Intro call"></label>
    <label class="field">Description<input class="input" name="description" value="${esc(existing?.description ?? "")}"></label>
    <div class="grid2">
      <label class="field">Length (minutes)<input class="input" type="number" name="durationMin" min="5" max="480" value="${existing?.durationMin ?? 30}"></label>
      <label class="field">Time zone<input class="input" name="timezone" value="${esc(tz)}"></label>
      <label class="field">Minimum notice (hours)<input class="input" type="number" name="minNoticeHours" min="0" value="${existing?.minNoticeHours ?? 4}"></label>
      <label class="field">Tags to add<input class="input" name="tags" value="${esc((existing?.tags ?? ["booked-call"]).join(", "))}"></label>
    </div>
    <div class="field">Available hours<div class="hours">${DAYS.map(([d, l]) => {
      const r = av[d]?.[0];
      return `<div class="row day"><label class="check"><input type="checkbox" name="d${d}" ${r ? "checked" : ""}>${l}</label>
        <input class="input small" type="time" name="s${d}" value="${r?.start ?? "09:00"}"><span>–</span><input class="input small" type="time" name="e${d}" value="${r?.end ?? "17:00"}"></div>`;
    }).join("")}</div></div>`, async (f) => {
    const availability = {};
    for (const [d] of DAYS) if (f.get(`d${d}`)) availability[d] = [{ start: f.get(`s${d}`), end: f.get(`e${d}`) }];
    const body = { name: f.get("name"), description: f.get("description") || undefined, durationMin: Number(f.get("durationMin")), timezone: f.get("timezone"),
      minNoticeHours: Number(f.get("minNoticeHours")), tags: tagsIn(f.get("tags")), availability };
    if (existing) await api("PATCH", `/api/crm/calendars/${existing.id}`, body); else await api("POST", "/api/crm/calendars", body);
    toast(existing ? "Calendar saved" : "Calendar created");
    renderCalendars();
  });
}

/* ---------------- Automations ---------------- */

const TRIGGERS = [
  ["contact.created", "A person is added"], ["tag.added", "A tag is added"], ["form.submitted", "A form is submitted"],
  ["appointment.booked", "An appointment is booked"], ["deal.stage_changed", "A deal changes stage"],
];
const STEPS = {
  send_email: { label: "Send email", fields: [["subject", "Subject"], ["body", "Message", "textarea"]] },
  send_sms: { label: "Send SMS", fields: [["body", "Message", "textarea"]] },
  wait: { label: "Wait", fields: [["minutes", "Minutes", "number"]] },
  add_tag: { label: "Add tag", fields: [["tag", "Tag"]] },
  remove_tag: { label: "Remove tag", fields: [["tag", "Tag"]] },
  create_task: { label: "Create task", fields: [["summary", "Task"], ["dueInDays", "Due in days", "number"]] },
  move_deal: { label: "Move deal", fields: [["stage", "Stage", "stage"]] },
  note: { label: "Add note", fields: [["text", "Note", "textarea"]] },
  request_review: { label: "Request a review", fields: [["channel", "Send by", "channel"]] },
};
const STAGES = ["lead", "qualified", "discovery", "proposal", "negotiation", "won", "lost"];
const describeTrigger = (t, forms, cals) => {
  const base = TRIGGERS.find(([v]) => v === t.type)?.[1] ?? t.type;
  const narrow = t.tag ? `: ${t.tag}` : t.formId ? `: ${forms.get(t.formId) ?? "a form"}` : t.calendarId ? `: ${cals.get(t.calendarId) ?? "a calendar"}` : t.toStage ? ` to ${t.toStage}` : "";
  return base + narrow;
};
const describeStep = (s) => {
  switch (s.type) {
    case "wait": return s.minutes % 1440 === 0 ? `Wait ${s.minutes / 1440} day${s.minutes === 1440 ? "" : "s"}` : s.minutes % 60 === 0 ? `Wait ${s.minutes / 60} h` : `Wait ${s.minutes} min`;
    case "send_email": return `Email “${s.subject}”`;
    case "send_sms": return `SMS “${s.body.slice(0, 40)}”`;
    case "add_tag": return `Tag +${s.tag}`;
    case "remove_tag": return `Tag −${s.tag}`;
    case "create_task": return `Task: ${s.summary}`;
    case "move_deal": return `Deal → ${s.stage}`;
    case "note": return "Note";
    case "request_review": return `Ask for a review by ${s.channel === "sms" ? "SMS" : "email"}`;
    default: return s.type;
  }
};

async function renderAutomations() {
  const id = S.route().id;
  const [flows, forms, cals] = await Promise.all([api("GET", "/api/crm/workflows"), api("GET", "/api/crm/forms"), api("GET", "/api/crm/calendars")]);
  const fm = new Map(forms.map((f) => [f.id, f.name]));
  const cm = new Map(cals.map((c) => [c.id, c.name]));
  if (id) return renderWorkflow(id, fm, cm, forms, cals);
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Automations</h1><button class="btn primary" id="new-flow">New automation</button></div>
      <p class="muted">When something happens, +SPCTR™ follows up for you: emails, texts, tags, tasks and waits.</p>
      ${flows.length ? `<div class="list">${flows.map((w) => `
        <a class="item" href="#/automations/${esc(w.id)}">
          <div class="main"><div class="title">${esc(w.name)} <span class="pill ${w.active ? "low" : ""}">${w.active ? "on" : "off"}</span></div>
          <div class="sub">When ${esc(describeTrigger(w.trigger, fm, cm).toLowerCase())} → ${w.steps.map((s) => esc(describeStep(s))).join(" → ")}</div></div>
          <div class="faint small nowrap">${w.stats.started} started · ${w.stats.completed} done${w.stats.failed ? ` · ${w.stats.failed} failed` : ""}</div>
        </a>`).join("")}</div>` : `<div class="empty">No automations yet. A good first one: when a form is submitted, email a thank-you and create a follow-up task.</div>`}
    </div>`;
  S.$("#new-flow").onclick = () => workflowEditor(undefined, forms, cals);
}

async function renderWorkflow(id, fm, cm, forms, cals) {
  const [w, jobs] = await Promise.all([api("GET", `/api/crm/workflows/${encodeURIComponent(id)}`), api("GET", `/api/crm/workflows/${encodeURIComponent(id)}/jobs`)]);
  const flow = w.workflow ?? w;
  const runs = jobs.jobs ?? jobs;
  const people = new Map((await contacts().catch(() => [])).map((c) => [c.id, c.name]));
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${esc(flow.name)}</h1><div class="row">
        <button class="btn" id="toggle">${flow.active ? "Turn off" : "Turn on"}</button>
        <button class="btn" id="delete">Delete</button>
        <button class="btn primary" id="edit">Edit</button></div></div>
      <a class="faint small" href="#/automations">‹ All automations</a>
      <div class="section"><h2>Steps</h2>
        <ol class="steps"><li class="trigger">When ${esc(describeTrigger(flow.trigger, fm, cm).toLowerCase())}</li>
        ${flow.steps.map((s) => `<li>${esc(describeStep(s))}${s.body && s.type !== "send_sms" ? `<div class="faint small">${esc(s.body.slice(0, 160))}</div>` : ""}</li>`).join("")}</ol>
      </div>
      <div class="section"><h2>Recent runs</h2>
        ${Array.isArray(runs) && runs.length ? `<div class="list">${runs.slice(0, 50).map((j) => `
          <div class="item"><span class="pill ${j.status === "failed" ? "high" : j.status === "done" ? "low" : ""}">${esc(j.status)}</span>
          <div class="main"><div class="title">${esc(people.get(j.contactId) ?? j.contactId ?? j.dealId ?? "")}</div>
          <div class="sub">${(j.log || []).map((l) => esc(`${l.step}: ${l.result}`)).join(" · ") || `waiting until ${when(j.runAt)}`}</div></div>
          <div class="faint small">${ago(j.createdAt)}</div></div>`).join("")}</div>` : `<div class="empty">No runs yet.</div>`}
      </div>
    </div>`;
  S.$("#edit").onclick = () => workflowEditor(flow, forms, cals);
  S.$("#toggle").onclick = () => act(async () => { await api("PATCH", `/api/crm/workflows/${flow.id}`, { active: !flow.active }); renderAutomations(); }, flow.active ? "Automation off" : "Automation on");
  S.$("#delete").onclick = () => {
    if (!confirm(`Delete “${flow.name}”? Runs in progress stop.`)) return;
    act(async () => { await api("DELETE", `/api/crm/workflows/${flow.id}`); location.hash = "#/automations"; }, "Automation deleted");
  };
}

function stepRow(s = { type: "send_email" }) {
  const spec = STEPS[s.type];
  return `<div class="step-row" data-type="${s.type}">
    <div class="row"><select class="input small" name="type">${Object.entries(STEPS).map(([v, d]) => `<option value="${v}" ${v === s.type ? "selected" : ""}>${d.label}</option>`).join("")}</select>
    <button type="button" class="btn ghost small" data-up aria-label="Move up">↑</button><button type="button" class="btn ghost small" data-remove aria-label="Remove">✕</button></div>
    ${spec.fields.map(([k, label, kind]) => `<label class="mini">${label}${kind === "textarea"
      ? `<textarea class="input small" name="${k}" rows="2" placeholder="${label}" required>${esc(s[k] ?? "")}</textarea>`
      : kind === "channel" ? `<select class="input small" name="${k}"><option value="email">Email</option><option value="sms" ${s[k] === "sms" ? "selected" : ""}>SMS</option></select>`
      : kind === "stage" ? `<select class="input small" name="${k}">${STAGES.map((v) => `<option ${v === s[k] ? "selected" : ""}>${v}</option>`).join("")}</select>`
      : `<input class="input small" name="${k}" placeholder="${label}" ${kind === "number" ? `type="number" min="${k === "minutes" ? 1 : 0}"` : ""} value="${esc(s[k] ?? (k === "minutes" ? 1440 : k === "dueInDays" ? 1 : ""))}" ${k === "dueInDays" ? "" : "required"}>`}</label>`).join("")}
  </div>`;
}

function workflowEditor(existing, forms, cals) {
  const t = existing?.trigger ?? { type: "form.submitted" };
  const steps = existing?.steps ?? [
    { type: "send_email", subject: "Thanks, {{first_name}}", body: "Hi {{first_name}}, thanks for reaching out. We'll be in touch shortly." },
    { type: "create_task", summary: "Follow up with {{name}}", dueInDays: 1 },
  ];
  S.modal(`<h2>${existing ? "Edit automation" : "New automation"}</h2>
    <label class="field">Name<input class="input" name="name" required value="${esc(existing?.name ?? "")}" placeholder="New lead follow-up"></label>
    <div class="grid2">
      <label class="field">When<select class="input" name="trigger">${TRIGGERS.map(([v, l]) => `<option value="${v}" ${v === t.type ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="field" id="narrow"></label>
    </div>
    <div class="field">Then<div id="step-rows">${steps.map(stepRow).join("")}</div><button type="button" class="btn small" id="add-step">Add step</button>
    <div class="faint small">Use {{first_name}}, {{name}} or {{email}} in messages.</div></div>
    <label class="check"><input type="checkbox" name="active" ${existing?.active === false ? "" : "checked"}>Turn on now</label>`, async (f) => {
    const type = f.get("trigger");
    const trigger = { type };
    const n = f.get("narrow");
    if (n) trigger[{ "tag.added": "tag", "form.submitted": "formId", "appointment.booked": "calendarId", "deal.stage_changed": "toStage" }[type]] = n;
    const out = [...document.querySelectorAll("#step-rows .step-row")].map((r) => {
      const s = { type: r.querySelector("[name=type]").value };
      for (const [k, , kind] of STEPS[s.type].fields) {
        const v = r.querySelector(`[name=${k}]`)?.value ?? "";
        if (kind === "number") { if (v !== "") s[k] = Number(v); } else s[k] = v;
      }
      return s;
    });
    const body = { name: f.get("name"), trigger, steps: out, active: !!f.get("active") };
    const saved = existing ? await api("PATCH", `/api/crm/workflows/${existing.id}`, body) : await api("POST", "/api/crm/workflows", body);
    toast(existing ? "Automation saved" : "Automation created");
    const sid = (saved.workflow ?? saved).id;
    if (location.hash === `#/automations/${sid}`) renderAutomations(); else location.hash = `#/automations/${sid}`;
  });
  const narrow = S.$("#narrow");
  const trig = document.querySelector("#modal-form [name=trigger]");
  const drawNarrow = () => {
    const v = trig.value;
    narrow.innerHTML = v === "tag.added" ? `Which tag<input class="input" name="narrow" required value="${esc(t.tag ?? "")}" placeholder="hot-lead">`
      : v === "form.submitted" ? `Which form<select class="input" name="narrow"><option value="">Any form</option>${forms.map((f) => `<option value="${esc(f.id)}" ${f.id === t.formId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>`
      : v === "appointment.booked" ? `Which calendar<select class="input" name="narrow"><option value="">Any calendar</option>${cals.map((c) => `<option value="${esc(c.id)}" ${c.id === t.calendarId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`
      : v === "deal.stage_changed" ? `To stage<select class="input" name="narrow"><option value="">Any stage</option>${STAGES.map((s) => `<option ${s === t.toStage ? "selected" : ""}>${s}</option>`).join("")}</select>`
      : "";
  };
  trig.onchange = drawNarrow;
  drawNarrow();
  const rows = S.$("#step-rows");
  const wire = () => rows.querySelectorAll(".step-row").forEach((r) => {
    r.querySelector("[data-remove]").onclick = () => r.remove();
    r.querySelector("[data-up]").onclick = () => r.previousElementSibling && rows.insertBefore(r, r.previousElementSibling);
    r.querySelector("[name=type]").onchange = (e) => { r.outerHTML = stepRow({ type: e.target.value }); wire(); };
  });
  wire();
  S.$("#add-step").onclick = () => { rows.insertAdjacentHTML("beforeend", stepRow({ type: "wait", minutes: 1440 })); wire(); };
}

/* ---------------- Campaigns ---------------- */

const STATUS_PILL = { draft: "", scheduled: "", sending: "", sent: "low", cancelled: "high" };
const audienceLabel = (a, lists) => a.listId ? `List: ${lists.get(a.listId) ?? "deleted list"}` : a.tags?.length ? `Tagged ${a.tags.join(", ")}` : "Everyone";

async function renderCampaigns() {
  const id = S.route().id;
  const [camps, lists] = await Promise.all([api("GET", "/api/crm/campaigns"), api("GET", "/api/crm/lists")]);
  const lm = new Map(lists.map((l) => [l.id, l.name]));
  if (id) return renderCampaign(id, lm, lists);
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Campaigns</h1><button class="btn primary" id="new-camp">New campaign</button></div>
      <p class="muted">Send one email or text to many people at once: a tag, a smart list, or everyone. People who opted out are never included.</p>
      ${camps.length ? `<div class="list">${camps.map((c) => `
        <a class="item" href="#/campaigns/${esc(c.id)}">
          <span class="pill">${c.channel === "sms" ? "SMS" : "Email"}</span>
          <div class="main"><div class="title">${esc(c.name)} <span class="pill ${STATUS_PILL[c.status]}">${esc(c.status)}</span></div>
          <div class="sub">${esc(audienceLabel(c.audience, lm))}${c.status === "scheduled" ? ` · sends ${when(c.scheduledAt)}` : ""}${c.sentAt ? ` · sent ${ago(c.sentAt)} to ${c.stats.recipients}` : ""}</div></div>
        </a>`).join("")}</div>` : `<div class="empty">No campaigns yet. Announce something to your customers in a minute.</div>`}
    </div>`;
  S.$("#new-camp").onclick = () => campaignEditor(undefined, lists);
}

async function renderCampaign(id, lm, lists) {
  const c = await api("GET", `/api/crm/campaigns/${encodeURIComponent(id)}`);
  const editable = c.status === "draft" || c.status === "scheduled";
  const n = c.audienceNow;
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${esc(c.name)}</h1><div class="row">
        ${editable ? `<button class="btn" id="edit">Edit</button>` : ""}
        ${c.status === "scheduled" ? `<button class="btn" id="cancel">Cancel schedule</button>` : ""}
        <button class="btn" id="delete">Delete</button>
        ${editable ? `<button class="btn primary" id="send">Send now</button>` : ""}</div></div>
      <a class="faint small" href="#/campaigns">‹ All campaigns</a>
      <div class="section"><h2>${c.channel === "sms" ? "SMS" : "Email"} · <span class="pill ${STATUS_PILL[c.status]}">${esc(c.status)}</span></h2>
        <p class="muted">${esc(audienceLabel(c.audience, lm))}${c.status === "scheduled" ? ` · sends ${when(c.scheduledAt)}` : ""}${c.sentAt ? ` · sent ${when(c.sentAt)}` : ""}</p>
        <div class="bubble out preview">${c.subject ? `<div class="subject">${esc(c.subject)}</div>` : ""}<div class="body">${esc(c.body)}</div></div>
      </div>
      ${c.status === "sent" ? `<div class="section"><h2>Results</h2><div class="stats">
        ${[["Recipients", c.stats.recipients], ["Sent", c.stats.sent], ["Drafts", c.stats.drafted], ["Failed", c.stats.failed], ["Skipped", c.stats.skipped]].map(([l, v]) => `<div class="stat"><div class="num">${v}</div><div class="faint small">${l}</div></div>`).join("")}
        </div>${c.stats.drafted ? `<p class="faint small">Drafts: no ${c.channel === "sms" ? "SMS" : "email"} provider was connected, so the messages wait on each person's conversation.</p>` : ""}</div>`
      : n ? `<div class="section"><h2>Audience right now</h2><p><b>${n.total}</b> ${n.total === 1 ? "person" : "people"}${n.sample.length ? `: ${n.sample.map(esc).join(", ")}${n.total > n.sample.length ? "…" : ""}` : ""}</p>
        ${n.noAddress ? `<p class="faint small">${n.noAddress} more have no ${c.channel === "sms" ? "phone number" : "email address"}.</p>` : ""}${n.optedOut ? `<p class="faint small">${n.optedOut} opted out and won't get it.</p>` : ""}</div>` : ""}
    </div>`;
  S.$("#edit")?.addEventListener("click", () => campaignEditor(c, lists));
  S.$("#cancel")?.addEventListener("click", () => act(async () => { await api("PATCH", `/api/crm/campaigns/${c.id}`, { status: "cancelled" }); renderCampaigns(); }, "Schedule cancelled"));
  S.$("#delete").onclick = () => { if (confirm(`Delete “${c.name}”?`)) act(async () => { await api("DELETE", `/api/crm/campaigns/${c.id}`); location.hash = "#/campaigns"; }, "Campaign deleted"); };
  S.$("#send")?.addEventListener("click", () => {
    if (!confirm(`Send “${c.name}” to ${n?.total ?? 0} ${n?.total === 1 ? "person" : "people"} now? This can't be undone.`)) return;
    act(async () => { const r = await api("POST", `/api/crm/campaigns/${c.id}/send`, {});
      const st = r.stats;
      toast([st.sent && `Sent to ${st.sent}`, st.drafted && `${st.drafted} saved as draft${st.drafted === 1 ? "" : "s"}`, st.failed && `${st.failed} failed`].filter(Boolean).join(" · ") || "No one to send to");
      renderCampaigns(); });
  });
}

function campaignEditor(existing, lists) {
  const a = existing?.audience ?? {};
  const mode = a.listId ? "list" : a.tags?.length ? "tags" : "all";
  const local = (iso) => { if (!iso) return ""; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  S.modal(`<h2>${existing ? "Edit campaign" : "New campaign"}</h2>
    <label class="field">Name<input class="input" name="name" required value="${esc(existing?.name ?? "")}" placeholder="Spring offer"></label>
    <div class="grid2">
      <label class="field">Send by<select class="input" name="channel"><option value="email">Email</option><option value="sms" ${existing?.channel === "sms" ? "selected" : ""}>SMS</option></select></label>
      <label class="field">To<select class="input" name="mode"><option value="all">Everyone</option><option value="tags" ${mode === "tags" ? "selected" : ""}>People with a tag</option>${lists.length ? `<option value="list" ${mode === "list" ? "selected" : ""}>A smart list</option>` : ""}</select></label>
    </div>
    <label class="field" data-for="tags">Tags (any of them)<input class="input" name="tags" value="${esc((a.tags ?? []).join(", "))}" placeholder="vip, webinar"></label>
    <label class="field" data-for="list">Smart list<select class="input" name="listId">${lists.map((l) => `<option value="${esc(l.id)}" ${l.id === a.listId ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select></label>
    <label class="field" data-for="email">Subject<input class="input" name="subject" value="${esc(existing?.subject ?? "")}" placeholder="Something for you, {{first_name}}"></label>
    <label class="field">Message<textarea class="input" name="body" rows="5" required placeholder="Hi {{first_name}}, …">${esc(existing?.body ?? "")}</textarea></label>
    <label class="field">Send later (optional)<input class="input" type="datetime-local" name="scheduledAt" value="${local(existing?.scheduledAt)}"></label>
    <p class="faint small" id="aud-count">Counting…</p>`, async (f) => {
    const m = f.get("mode");
    const body = { name: f.get("name"), channel: f.get("channel"), subject: f.get("subject") || undefined, body: f.get("body"),
      audience: m === "list" ? { listId: f.get("listId") } : m === "tags" ? { tags: tagsIn(f.get("tags")) } : {},
      scheduledAt: f.get("scheduledAt") ? new Date(f.get("scheduledAt")).toISOString() : null };
    const saved = existing ? await api("PATCH", `/api/crm/campaigns/${existing.id}`, body) : await api("POST", "/api/crm/campaigns", body);
    toast(saved.status === "scheduled" ? "Campaign scheduled" : "Campaign saved as draft");
    if (location.hash === `#/campaigns/${saved.id}`) renderCampaigns(); else location.hash = `#/campaigns/${saved.id}`;
  });
  const form = S.$("#modal-form");
  templatePicker(form);
  let timer;
  const sync = () => {
    const m = form.mode.value;
    form.querySelector("[data-for=tags]").hidden = m !== "tags";
    form.querySelector("[data-for=list]").hidden = m !== "list";
    form.querySelector("[data-for=email]").hidden = form.channel.value !== "email";
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const r = await api("POST", "/api/crm/campaigns/preview", { channel: form.channel.value,
          audience: m === "list" ? { listId: form.listId.value } : m === "tags" ? { tags: tagsIn(form.tags.value) } : {} });
        S.$("#aud-count").textContent = `Reaches ${r.total} ${r.total === 1 ? "person" : "people"}${r.noAddress ? ` · ${r.noAddress} without ${form.channel.value === "sms" ? "a phone number" : "an email"}` : ""}${r.optedOut ? ` · ${r.optedOut} opted out` : ""}.`;
      } catch (e) { S.$("#aud-count").textContent = e.message; }
    }, 250);
  };
  ["mode", "channel", "listId"].forEach((n) => form[n]?.addEventListener("change", sync));
  form.tags.addEventListener("input", sync);
  sync();
}

/* ---------------- Reputation ---------------- */

const starsText = (n) => n ? "★".repeat(n) + "☆".repeat(5 - n) : "";

async function renderReputation() {
  const d = await api("GET", "/api/crm/reviews");
  const s = d.settings, st = d.stats;
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Reputation</h1><button class="btn primary" id="ask" ${s.reviewUrl ? "" : "disabled"}>Ask for reviews</button></div>
      <p class="muted">Ask happy customers for a review in one click. Each person gets a private link: they rate you, can leave a public review, or tell you privately what to fix. Low ratings become follow-up tasks.</p>
      <div class="stats">${[["Asked", st.requested], ["Opened", st.opened], ["Rated", st.rated], ["Average", st.average ?? "–"], ["Went to review", st.clicked], ["Private notes", st.feedback]]
        .map(([l, v]) => `<div class="stat"><div class="num">${esc(v)}</div><div class="faint small">${l}</div></div>`).join("")}</div>
      <div class="section"><h2>Review link</h2>
        <form id="rv-settings" class="grid2">
          <label class="field">Business name<input class="input" name="businessName" value="${esc(s.businessName)}" placeholder="Northwind Logistics"></label>
          <label class="field">Public review link<input class="input" name="reviewUrl" value="${esc(s.reviewUrl ?? "")}" placeholder="https://g.page/r/…/review"></label>
          <div class="row"><button class="btn">Save</button><span class="faint small">In Google Business Profile: <b>Ask for reviews</b> → copy the link. Any review site works.</span></div>
        </form>
        <p class="faint small">Everyone sees the public link, whatever they rate. Steering only happy customers to public reviews breaks Google's rules.</p>
      </div>
      <div class="section"><h2>Requests</h2>
        ${d.requests.length ? `<div class="table-wrap"><table class="simple"><thead><tr><th>Person</th><th>Asked</th><th>By</th><th>Status</th><th>Rating</th><th>Private note</th></tr></thead><tbody>
        ${d.requests.map((r) => `<tr><td>${esc(r.name)}</td><td class="nowrap">${date(r.sentAt)}</td><td>${r.channel === "sms" ? "SMS" : "Email"}${r.messageStatus === "sent" ? "" : ` · ${esc(r.messageStatus)}`}</td>
          <td class="nowrap">${r.clickedAt ? "Went to review" : r.ratedAt ? "Rated" : r.openedAt ? "Opened" : "Waiting"}</td><td class="stars-cell">${starsText(r.rating)}</td><td>${esc(r.feedback ?? "")}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="empty">${s.reviewUrl ? "No requests yet." : "Add your review link to start."}</div>`}
      </div>
    </div>`;
  const f = S.$("#rv-settings");
  f.onsubmit = (e) => { e.preventDefault(); act(async () => { await api("PUT", "/api/crm/reviews/settings", { businessName: f.businessName.value, reviewUrl: f.reviewUrl.value || undefined }); renderReputation(); }, "Saved"); };
  S.$("#ask").onclick = () => askForReviews(s);
}

async function askForReviews(settings) {
  const people = await contacts();
  const recentlyWon = new Set(((await api("GET", "/api/deals").catch(() => ({})))?.deals ?? []).filter((d) => d.stage === "won").flatMap((d) => d.contactIds || []));
  S.modal(`<h2>Ask for reviews</h2>
    <label class="field">Send by<select class="input" name="channel"><option value="sms">SMS</option><option value="email">Email</option></select></label>
    <div class="field">Who<input class="input small" id="pick-filter" placeholder="Filter people…">
      <div class="row small"><button type="button" class="btn ghost small" id="pick-won">Customers with won deals</button><button type="button" class="btn ghost small" id="pick-none">Clear</button></div>
      <div class="pick">${people.map((c) => `<label class="check" data-name="${esc(c.name.toLowerCase())}"><input type="checkbox" name="cid" value="${esc(c.id)}" data-won="${recentlyWon.has(c.id) ? 1 : 0}">${esc(c.name)}<span class="faint small">${esc(c.phone || c.email || "no contact info")}</span></label>`).join("") || `<p class="faint small">Add people first.</p>`}</div></div>
    <label class="field">Message<textarea class="input" name="message" rows="4" placeholder="Leave empty for the standard message"></textarea></label>
    <p class="faint small">Keep {{review_link}} if you write your own. Also works: {{first_name}}. People asked in the last 30 days, or who opted out, are skipped.</p>`, async (f) => {
    const ids = f.getAll("cid");
    if (!ids.length) throw new Error("Choose who to ask");
    const r = await api("POST", "/api/crm/reviews/request", { contactIds: ids, channel: f.get("channel"), message: f.get("message") || undefined });
    toast([r.sent && `Asked ${r.sent}`, r.drafted && `${r.drafted} saved as draft${r.drafted === 1 ? "" : "s"}`, r.failed && `${r.failed} failed`, r.skipped.length && `${r.skipped.length} skipped`].filter(Boolean).join(" · ") || "No one asked");
    renderReputation();
  });
  const box = document.querySelector("#modal-form .pick");
  S.$("#pick-filter").oninput = (e) => { const q = e.target.value.toLowerCase(); box.querySelectorAll("label").forEach((l) => { l.hidden = q && !l.dataset.name.includes(q); }); };
  S.$("#pick-won").onclick = () => box.querySelectorAll("input").forEach((i) => { if (i.dataset.won === "1") i.checked = true; });
  S.$("#pick-none").onclick = () => box.querySelectorAll("input").forEach((i) => { i.checked = false; });
}

/* ---------------- Invoices ---------------- */

const fmtMoney = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${cur}`; } };
const CURS = ["USD", "EUR", "GBP", "RUB", "CAD", "AUD", "CHF", "JPY", "CNY", "INR", "AED", "SGD", "BRL", "MXN", "ZAR", "SEK", "NOK", "DKK", "PLN", "TRY", "KZT"];
const invStatus = (i) => i.overdue ? `<span class="pill high">overdue</span>` : `<span class="pill ${i.status === "paid" ? "low" : i.status === "void" ? "high" : ""}">${esc(i.status)}</span>`;

async function renderInvoices() {
  const id = S.route().id;
  if (id) return renderInvoice(id);
  const d = await api("GET", "/api/crm/invoices");
  const s = d.settings;
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Invoices</h1><button class="btn primary" id="new-inv">New invoice</button></div>
      <p class="muted">Bill customers with a link they can open, print and pay. Payments go through your own payment page (for example a Stripe Payment Link); +SPCTR™ never handles the money. Mark an invoice paid when it arrives.</p>
      ${Object.keys(d.totals).length ? `<div class="stats">${Object.entries(d.totals).flatMap(([cur, t]) => [["Outstanding", t.outstandingCents], ["Overdue", t.overdueCents], ["Paid", t.paidCents]]
        .map(([l, v]) => `<div class="stat"><div class="num">${fmtMoney(v, cur)}</div><div class="faint small">${l}${Object.keys(d.totals).length > 1 ? ` · ${cur}` : ""}</div></div>`)).join("")}</div>` : ""}
      <div class="section">${d.invoices.length ? `<div class="list">${d.invoices.map((i) => `
        <a class="item" href="#/invoices/${esc(i.id)}">
          <div class="main"><div class="title">${esc(i.number)} · ${esc(i.name)} ${invStatus(i)}</div>
          <div class="sub">Due ${date(i.dueDate + "T00:00:00Z")}${i.viewedAt ? " · viewed" : ""}${i.paidAt ? ` · paid ${ago(i.paidAt)}` : ""}</div></div>
          <div class="nowrap">${fmtMoney(i.totalCents, i.currency)}</div>
        </a>`).join("")}</div>` : `<div class="empty">No invoices yet.</div>`}</div>
      <div class="section"><h2>Invoice settings</h2>
        <form id="inv-settings">
          <label class="field">From (your business name, address, tax ID)<textarea class="input" name="from" rows="3">${esc(s.from)}</textarea></label>
          <div class="grid2">
            <label class="field">Default currency<select class="input" name="currency">${CURS.map((c) => `<option ${c === s.currency ? "selected" : ""}>${c}</option>`).join("")}</select></label>
            <label class="field">Default payment link<input class="input" name="paymentUrl" value="${esc(s.paymentUrl ?? "")}" placeholder="https://buy.stripe.com/…"></label>
          </div>
          <button class="btn">Save</button>
        </form>
      </div>
    </div>`;
  const f = S.$("#inv-settings");
  f.onsubmit = (e) => { e.preventDefault(); act(async () => { await api("PUT", "/api/crm/invoices/settings", { from: f.from.value, currency: f.currency.value, paymentUrl: f.paymentUrl.value || undefined }); renderInvoices(); }, "Saved"); };
  S.$("#new-inv").onclick = () => invoiceEditor(undefined, s);
}

function lineRow(l = { description: "", quantity: 1, unitCents: 0 }) {
  return `<div class="line-row"><input class="input small" name="description" placeholder="Description" value="${esc(l.description)}" required>
    <input class="input small" name="quantity" type="number" min="0.01" step="0.01" value="${esc(l.quantity)}" aria-label="Quantity">
    <input class="input small" name="price" type="number" min="0" step="0.01" value="${l.unitCents ? (l.unitCents / 100).toFixed(2) : ""}" placeholder="Price" aria-label="Unit price" required>
    <button type="button" class="btn ghost small" data-remove aria-label="Remove">✕</button></div>`;
}

async function invoiceEditor(existing, settings) {
  const [people, deals] = await Promise.all([contacts(), api("GET", "/api/deals").then((r) => r.deals ?? []).catch(() => [])]);
  settings ??= (await api("GET", "/api/crm/invoices")).settings;
  const cur = existing?.currency ?? settings.currency;
  S.modal(`<h2>${existing ? `Edit ${esc(existing.number)}` : "New invoice"}</h2>
    <div class="grid2">
      <label class="field">Bill to<select class="input" name="contactId" required>${people.map((c) => `<option value="${esc(c.id)}" ${c.id === existing?.contactId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      <label class="field">Deal (optional)<select class="input" name="dealId"><option value="">None</option>${deals.map((d) => `<option value="${esc(d.id)}" ${d.id === existing?.dealId ? "selected" : ""}>${esc(d.name)}${d.company ? ` · ${esc(d.company)}` : ""}</option>`).join("")}</select></label>
    </div>
    <div class="field">Lines<div id="line-rows">${(existing?.items ?? [undefined]).map(lineRow).join("")}</div><button type="button" class="btn small" id="add-line">Add line</button></div>
    <div class="grid2">
      <label class="field">Currency<select class="input" name="currency">${CURS.map((c) => `<option ${c === cur ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label class="field">Tax %<input class="input" type="number" name="taxRate" min="0" max="100" step="0.01" value="${existing?.taxRate ?? 0}"></label>
      <label class="field">Due date<input class="input" type="date" name="dueDate" value="${esc(existing?.dueDate ?? new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10))}"></label>
      <label class="field">Payment link<input class="input" name="paymentUrl" value="${esc(existing?.paymentUrl ?? settings.paymentUrl ?? "")}" placeholder="https://buy.stripe.com/…"></label>
    </div>
    <label class="field">Notes<textarea class="input" name="notes" rows="2" placeholder="Payment terms, bank details…">${esc(existing?.notes ?? "")}</textarea></label>
    <p class="faint small" id="inv-total"></p>`, async (f) => {
    const items = [...document.querySelectorAll("#line-rows .line-row")].map((r) => ({
      description: r.querySelector("[name=description]").value, quantity: Number(r.querySelector("[name=quantity]").value || 1),
      unitCents: Math.round(Number(r.querySelector("[name=price]").value || 0) * 100),
    }));
    const body = { contactId: f.get("contactId"), dealId: f.get("dealId") || undefined, items, currency: f.get("currency"), taxRate: Number(f.get("taxRate") || 0),
      dueDate: f.get("dueDate") || undefined, paymentUrl: f.get("paymentUrl") || undefined, notes: f.get("notes") || undefined };
    const saved = existing ? await api("PATCH", `/api/crm/invoices/${existing.id}`, body) : await api("POST", "/api/crm/invoices", body);
    toast(existing ? "Invoice saved" : `${saved.number} created as a draft`);
    if (location.hash === `#/invoices/${saved.id}`) renderInvoices(); else location.hash = `#/invoices/${saved.id}`;
  });
  const form = S.$("#modal-form");
  const rows = S.$("#line-rows");
  const total = () => {
    const sub = [...rows.querySelectorAll(".line-row")].reduce((s, r) => s + Math.round(Number(r.querySelector("[name=quantity]").value || 0) * Math.round(Number(r.querySelector("[name=price]").value || 0) * 100)), 0);
    const tax = Math.round((sub * Number(form.taxRate.value || 0)) / 100);
    S.$("#inv-total").textContent = `Subtotal ${fmtMoney(sub, form.currency.value)}${tax ? ` · tax ${fmtMoney(tax, form.currency.value)}` : ""} · total ${fmtMoney(sub + tax, form.currency.value)}`;
  };
  const wire = () => rows.querySelectorAll(".line-row").forEach((r) => { r.querySelector("[data-remove]").onclick = () => { if (rows.children.length > 1) r.remove(); total(); }; });
  // The modal form is reused by later dialogs: drop this listener once the editor is gone.
  form.addEventListener("input", function onInput() { if (!rows.isConnected) return form.removeEventListener("input", onInput); total(); });
  S.$("#add-line").onclick = () => { rows.insertAdjacentHTML("beforeend", lineRow()); wire(); };
  wire();
  total();
}

async function renderInvoice(id) {
  const inv = await api("GET", `/api/crm/invoices/${encodeURIComponent(id)}`);
  const people = new Map((await contacts().catch(() => [])).map((c) => [c.id, c.name]));
  const m = (c) => fmtMoney(c, inv.currency);
  const overdue = inv.status === "sent" && inv.dueDate < new Date().toISOString().slice(0, 10);
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>${esc(inv.number)} ${invStatus({ ...inv, overdue })}</h1><div class="row">
        ${inv.status === "draft" ? `<button class="btn" id="edit">Edit</button>` : ""}
        ${inv.status === "draft" || inv.status === "sent" ? `<button class="btn" id="void">Void</button>` : ""}
        ${inv.status === "sent" ? `<button class="btn" id="copy-link">Copy customer link</button><button class="btn" id="resend">Send again</button><button class="btn primary" id="paid">Mark paid</button>` : ""}
        ${inv.status === "draft" ? `<button class="btn primary" id="send">Send</button>` : ""}</div></div>
      <a class="faint small" href="#/invoices">‹ All invoices</a>
      <p class="muted">To ${esc(people.get(inv.contactId) ?? "Removed")} · due ${date(inv.dueDate + "T00:00:00Z")}${inv.sentAt ? ` · sent ${ago(inv.sentAt)}` : ""}${inv.viewedAt ? ` · viewed ${ago(inv.viewedAt)}` : ""}${inv.paidAt ? ` · paid ${ago(inv.paidAt)}` : ""}</p>
      <div class="table-wrap"><table class="simple"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
        <tbody>${inv.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${esc(i.quantity)}</td><td class="num">${m(i.unitCents)}</td><td class="num">${m(Math.round(i.quantity * i.unitCents))}</td></tr>`).join("")}
        <tr><td colspan="3">Subtotal</td><td class="num">${m(inv.subtotalCents)}</td></tr>
        ${inv.taxRate ? `<tr><td colspan="3">Tax (${esc(inv.taxRate)}%)</td><td class="num">${m(inv.taxCents)}</td></tr>` : ""}
        <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${m(inv.totalCents)}</b></td></tr></tbody></table></div>
      ${inv.notes ? `<p class="muted pre">${esc(inv.notes)}</p>` : ""}
      <p class="faint small">${inv.paymentUrl ? `Pay button opens ${esc(new URL(inv.paymentUrl).host)}.` : "No payment link: the customer sees the invoice without a Pay button."}</p>
    </div>`;
  const send = (again) => S.modal(`<h2>${again ? "Send again" : `Send ${esc(inv.number)}`}</h2>
    <label class="field">Send by<select class="input" name="channel"><option value="email">Email</option><option value="sms">SMS</option></select></label>
    <p class="faint small">The customer gets a private link to view, print and pay.</p>`, async (f) => {
    const r = await api("POST", `/api/crm/invoices/${inv.id}/send`, { channel: f.get("channel") });
    toast(r.delivery === "sent" ? "Invoice sent" : r.delivery === "draft" ? "Saved as a draft message. Copy the customer link to share it." : `Not sent: ${r.error || "failed"}`);
    renderInvoices();
  });
  S.$("#send")?.addEventListener("click", () => send(false));
  S.$("#resend")?.addEventListener("click", () => send(true));
  S.$("#edit")?.addEventListener("click", () => invoiceEditor(inv));
  S.$("#paid")?.addEventListener("click", () => { if (confirm(`Mark ${inv.number} paid (${m(inv.totalCents)})?`)) act(async () => { await api("POST", `/api/crm/invoices/${inv.id}/status`, { status: "paid" }); renderInvoices(); }, "Marked paid"); });
  S.$("#void")?.addEventListener("click", () => { if (confirm(`Void ${inv.number}? The customer link will show it as void.`)) act(async () => { await api("POST", `/api/crm/invoices/${inv.id}/status`, { status: "void" }); renderInvoices(); }, "Invoice voided"); });
  S.$("#copy-link")?.addEventListener("click", () => act(async () => {
    const { url } = await api("GET", `/api/crm/invoices/${inv.id}/link`);
    try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { prompt("Customer link", url); }
  }));
}

/* ---------------- Contacts (tags and smart lists) ---------------- */

const cf = { q: "", tags: [], hasEmail: "", hasPhone: "", minScore: "", quietForDays: "", createdWithinDays: "", sort: "score" };
const cfSelected = new Set();
const describeFilter = (f) => [
  f.tags?.length && `tags: ${f.tags.join(" + ")}`, f.anyTags?.length && `any of: ${f.anyTags.join(", ")}`, f.text && `“${f.text}”`,
  f.minScore !== undefined && `score ≥ ${f.minScore}`, f.hasEmail !== undefined && (f.hasEmail ? "has email" : "no email"),
  f.hasPhone !== undefined && (f.hasPhone ? "has phone" : "no phone"), f.quietForDays && `quiet ${f.quietForDays}+ days`,
  f.createdWithinDays && `added in ${f.createdWithinDays} days`, f.source && `source: ${f.source}`,
].filter(Boolean).join(" · ") || "everyone";
const filterBody = () => {
  const f = { text: cf.q || undefined, tags: cf.tags.length ? cf.tags : undefined, minScore: cf.minScore || undefined, quietForDays: cf.quietForDays || undefined, createdWithinDays: cf.createdWithinDays || undefined };
  if (cf.hasEmail) f.hasEmail = cf.hasEmail === "1";
  if (cf.hasPhone) f.hasPhone = cf.hasPhone === "1";
  return f;
};

async function renderContacts() {
  const listId = S.route().id;
  const qs = new URLSearchParams({ sort: cf.sort });
  if (listId) qs.set("list", listId);
  else for (const [k, v] of Object.entries({ q: cf.q, tags: cf.tags.join(","), hasEmail: cf.hasEmail, hasPhone: cf.hasPhone, minScore: cf.minScore, quietForDays: cf.quietForDays, createdWithinDays: cf.createdWithinDays })) if (v) qs.set(k, v);
  const [d, lists] = await Promise.all([api("GET", `/api/crm/contacts?${qs}`), api("GET", "/api/crm/lists")]);
  const list = lists.find((l) => l.id === listId);
  const visible = new Set(d.contacts.map((c) => c.id));
  for (const id of cfSelected) if (!visible.has(id)) cfSelected.delete(id);
  const opt = (name, v, label) => `<option value="${v}" ${cf[name] === v ? "selected" : ""}>${label}</option>`;
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Contacts</h1>${listId ? "" : `<button class="btn" id="save-list">Save as smart list</button>`}</div>
      <div class="chips" id="lists">
        <a class="chip ${listId ? "" : "on"}" href="#/contacts">All</a>
        ${lists.map((l) => `<a class="chip ${l.id === listId ? "on" : ""}" href="#/contacts/${esc(l.id)}">${esc(l.name)} <span class="faint">${l.count}</span></a>`).join("")}
      </div>
      ${list ? `<div class="row wrap"><p class="muted">Smart list: ${esc(describeFilter(list.filter))}. It updates by itself as people change.</p><button class="btn ghost small" id="del-list">Delete list</button></div>` : `
      <form id="cf" class="filters">
        <input class="input" name="q" placeholder="Search name, email, phone, company" value="${esc(cf.q)}" aria-label="Search">
        <select class="input" name="hasEmail" aria-label="Email">${opt("hasEmail", "", "Any email")}${opt("hasEmail", "1", "Has email")}${opt("hasEmail", "0", "No email")}</select>
        <select class="input" name="hasPhone" aria-label="Phone">${opt("hasPhone", "", "Any phone")}${opt("hasPhone", "1", "Has phone")}${opt("hasPhone", "0", "No phone")}</select>
        <input class="input" name="minScore" type="number" min="0" max="100" placeholder="Min score" value="${esc(cf.minScore)}" aria-label="Minimum score">
        <input class="input" name="quietForDays" type="number" min="1" placeholder="Quiet for days" value="${esc(cf.quietForDays)}" aria-label="No activity for days">
        <input class="input" name="createdWithinDays" type="number" min="1" placeholder="Added within days" value="${esc(cf.createdWithinDays)}" aria-label="Added within days">
        <select class="input" name="sort" aria-label="Sort">${opt("sort", "score", "Top score")}${opt("sort", "recent", "Newest")}${opt("sort", "name", "Name")}</select>
      </form>
      ${d.tags.length ? `<div class="chips" id="tag-cloud">${d.tags.slice(0, 40).map((t) => `<button type="button" class="chip ${cf.tags.includes(t.tag) ? "on" : ""}" data-tag="${esc(t.tag)}">#${esc(t.tag)} <span class="faint">${t.count}</span></button>`).join("")}</div>` : ""}`}
      <div class="row wrap bulk">
        <label class="row small"><input type="checkbox" id="sel-all" ${d.contacts.length && cfSelected.size === d.contacts.length ? "checked" : ""}> <span id="sel-count">${cfSelected.size ? `${cfSelected.size} selected` : `${d.total} ${d.total === 1 ? "person" : "people"}`}</span></label>
        <button class="btn small" id="bulk-add" ${cfSelected.size ? "" : "disabled"}>Add tag</button>
        <button class="btn small" id="bulk-remove" ${cfSelected.size ? "" : "disabled"}>Remove tag</button>
      </div>
      ${d.contacts.length ? `<div class="list">${d.contacts.map((c) => `
        <div class="item contact-row">
          <input type="checkbox" data-sel="${esc(c.id)}" ${cfSelected.has(c.id) ? "checked" : ""} aria-label="Select ${esc(c.name)}">
          <div class="main"><div class="title">${esc(c.name)}${c.optedOut ? ` <span class="pill">opted out</span>` : ""}</div>
            <div class="sub">${esc([c.company, c.email, c.phone].filter(Boolean).join(" · "))}</div>
            ${c.tags?.length ? `<div class="chips tight">${c.tags.map((t) => `<span class="pill">#${esc(t)}</span>`).join("")}</div>` : ""}</div>
          <span class="pill ${c.band === "hot" ? "low" : ""}" title="Lead score">${c.score}</span>
          <button class="btn ghost small" data-tags="${esc(c.id)}">Tags</button>
          <a class="btn ghost small" href="#/inbox/${esc(c.id)}">Message</a>
        </div>`).join("")}</div>${d.total > d.contacts.length ? `<p class="faint small">Showing the first ${d.contacts.length} of ${d.total}.</p>` : ""}` : `<div class="empty">No one matches.</div>`}
    </div>`;
  const rerender = () => renderContacts();
  const f = S.$("#cf");
  if (f) {
    let t;
    f.oninput = (e) => { clearTimeout(t); t = setTimeout(() => { for (const k of ["q", "hasEmail", "hasPhone", "minScore", "quietForDays", "createdWithinDays", "sort"]) cf[k] = f[k].value.trim(); rerender().then(() => { const el = S.$(`#cf [name="${e.target.name}"]`); if (el && e.target.type !== "select-one") { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); } }); }, e.target.name === "q" ? 300 : 0); };
    f.onsubmit = (e) => e.preventDefault();
  }
  main().querySelectorAll("[data-tag]").forEach((b) => b.onclick = () => { const tg = b.dataset.tag; cf.tags = cf.tags.includes(tg) ? cf.tags.filter((x) => x !== tg) : [...cf.tags, tg]; rerender(); });
  const sync = () => {
    S.$("#sel-count").textContent = cfSelected.size ? `${cfSelected.size} selected` : `${d.total} ${d.total === 1 ? "person" : "people"}`;
    S.$("#bulk-add").disabled = S.$("#bulk-remove").disabled = !cfSelected.size;
  };
  main().querySelectorAll("[data-sel]").forEach((b) => b.onchange = () => { b.checked ? cfSelected.add(b.dataset.sel) : cfSelected.delete(b.dataset.sel); S.$("#sel-all").checked = cfSelected.size === d.contacts.length; sync(); });
  S.$("#sel-all").onchange = (e) => { main().querySelectorAll("[data-sel]").forEach((b) => { b.checked = e.target.checked; e.target.checked ? cfSelected.add(b.dataset.sel) : cfSelected.delete(b.dataset.sel); }); sync(); };
  const bulk = (remove) => S.modal(`<h2>${remove ? "Remove a tag from" : "Tag"} ${cfSelected.size} ${cfSelected.size === 1 ? "person" : "people"}</h2>
    <label class="field">Tags (comma separated)<input class="input" name="tags" list="tag-options" required autofocus></label>
    <datalist id="tag-options">${d.tags.map((t) => `<option value="${esc(t.tag)}">`).join("")}</datalist>
    ${remove ? "" : `<p class="faint small">Adding a tag can start automations that use the “tag added” trigger.</p>`}`, async (fd) => {
    const tags = tagsIn(fd.get("tags"));
    const r = await api("POST", "/api/crm/contacts/bulk-tag", { ids: [...cfSelected], [remove ? "remove" : "add"]: tags });
    toast(`${r.changed} ${r.changed === 1 ? "person" : "people"} updated`);
    rerender();
  });
  S.$("#bulk-add").onclick = () => bulk(false);
  S.$("#bulk-remove").onclick = () => bulk(true);
  main().querySelectorAll("[data-tags]").forEach((b) => b.onclick = () => {
    const c = d.contacts.find((x) => x.id === b.dataset.tags);
    S.modal(`<h2>Tags for ${esc(c.name)}</h2>
      <label class="field">Tags (comma separated)<input class="input" name="tags" value="${esc((c.tags ?? []).join(", "))}" list="tag-options"></label>
      <datalist id="tag-options">${d.tags.map((t) => `<option value="${esc(t.tag)}">`).join("")}</datalist>`, async (fd) => {
      const next = tagsIn(fd.get("tags")).map((t) => t.toLowerCase());
      const before = c.tags ?? [];
      await api("POST", `/api/crm/contacts/${c.id}/tags`, { add: next, remove: before.filter((t) => !next.includes(t)) });
      toast("Tags saved");
      rerender();
    });
  });
  S.$("#save-list")?.addEventListener("click", () => {
    const filter = filterBody();
    S.modal(`<h2>Save as smart list</h2>
      <p class="muted">${esc(describeFilter(filter))}</p>
      <label class="field">Name<input class="input" name="name" required maxlength="80" autofocus></label>
      <p class="faint small">A smart list keeps itself up to date. Use it as a campaign audience.</p>`, async (fd) => {
      const l = await api("POST", "/api/crm/lists", { name: fd.get("name"), filter });
      toast("Smart list saved");
      location.hash = `#/contacts/${l.id}`;
    });
  });
  S.$("#del-list")?.addEventListener("click", () => {
    if (!confirm(`Delete the smart list “${list.name}”? The people in it stay.`)) return;
    act(async () => { await api("DELETE", `/api/crm/lists/${list.id}`); location.hash = "#/contacts"; }, "List deleted");
  });
}

/* ---------------- Reporting ---------------- */

let reportDays = 30;
async function renderReporting() {
  const r = await api("GET", `/api/crm/reports/growth?days=${reportDays}`);
  const delta = ({ now, before }) => now === before ? `<span class="faint">same as before</span>`
    : `<span class="${now > before ? "up" : "down"}">${now > before ? "▲" : "▼"} ${before ? `${Math.round((Math.abs(now - before) / before) * 100)}%` : `+${now}`}</span>`;
  const tile = (label, t) => `<div class="stat"><div class="num">${t.now}</div><div class="faint small">${label}</div><div class="small">${delta(t)}</div></div>`;
  const max = Math.max(1, ...r.series.map((d) => d.contacts));
  const bars = (rows, key, label) => rows.length ? `<div class="hbars">${rows.map((x) => `<div class="hbar"><span>${esc(x[key])}</span><i style="--w:${Math.round((x.count / rows[0].count) * 100)}%"></i><b>${x.count}</b></div>`).join("")}</div>` : `<div class="empty">No ${label} in this period.</div>`;
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Reporting</h1>
        <div class="chips" role="group" aria-label="Period">${[7, 30, 90].map((d) => `<button type="button" class="chip ${d === r.days ? "on" : ""}" data-days="${d}">${d} days</button>`).join("")}</div></div>
      <p class="muted">${date(r.from)} – ${date(r.to)}, compared with the ${r.days} days before.</p>
      <div class="stats">
        ${tile("New contacts", r.totals.newContacts)}${tile("Form submissions", r.totals.formSubmissions)}${tile("Appointments booked", r.totals.appointmentsBooked)}
        ${tile("Messages sent", r.totals.messagesSent)}${tile("Replies received", r.totals.repliesReceived)}${tile("Deals won", r.totals.dealsWon)}
      </div>
      <div class="stats">
        <div class="stat"><div class="num">${S.money(r.wonValue)}</div><div class="faint small">Won value</div></div>
        <div class="stat"><div class="num">${r.winRate === null ? "—" : `${r.winRate}%`}</div><div class="faint small">Win rate (won ÷ closed)</div></div>
        <div class="stat"><div class="num">${r.averageRating === null ? "—" : `${r.averageRating}★`}</div><div class="faint small">Average rating · ${r.totals.reviewRequests.now} asked</div></div>
        <div class="stat"><div class="num">${r.invoicesPaid.length ? r.invoicesPaid.map((p) => fmtMoney(p.cents, p.currency)).join(" + ") : "—"}</div><div class="faint small">Invoices paid</div></div>
      </div>
      <div class="section"><h2>New contacts ${r.days === 90 ? "per week" : "per day"}</h2>
        <div class="vbars" role="img" aria-label="New contacts over time">${r.series.map((d) => `<i style="--h:${Math.round((d.contacts / max) * 100)}%" title="${esc(d.start)}: ${d.contacts}"></i>`).join("")}</div></div>
      <div class="grid2">
        <div class="section"><h2>Where contacts came from</h2>${bars(r.sources, "source", "new contacts")}</div>
        <div class="section"><h2>Forms</h2>${bars(r.forms, "name", "form submissions")}</div>
      </div>
    </div>`;
  main().querySelectorAll("[data-days]").forEach((b) => b.onclick = () => { reportDays = Number(b.dataset.days); renderReporting(); });
}

S.view("reporting", renderReporting);
/* ---------------- Templates ---------------- */

async function renderTemplates() {
  const list = await api("GET", "/api/crm/templates");
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Templates</h1><button class="btn primary" id="new-tpl">New template</button></div>
      <p class="muted">Saved emails and texts. Pick one in Conversations or Campaigns instead of typing it again. {{first_name}}, {{name}} and {{company}} fill in for each person.</p>
      ${list.length ? `<div class="list">${list.map((t) => `
        <div class="item"><div class="main"><div class="title">${esc(t.name)} <span class="pill">${t.channel === "sms" ? "SMS" : "Email"}</span></div>
          <div class="sub">${esc(t.subject ? `${t.subject} — ` : "")}${esc(t.body.slice(0, 120))}</div></div>
          <button class="btn ghost small" data-edit="${esc(t.id)}">Edit</button><button class="btn ghost small" data-del="${esc(t.id)}">Delete</button></div>`).join("")}</div>` : `<div class="empty">No templates yet.</div>`}
    </div>`;
  const editor = (t) => {
    S.modal(`<h2>${t ? "Edit template" : "New template"}</h2>
      <label class="field">Name<input class="input" name="name" required maxlength="80" value="${esc(t?.name ?? "")}" placeholder="Appointment reminder"></label>
      <label class="field">For<select class="input" name="channel"><option value="email">Email</option><option value="sms" ${t?.channel === "sms" ? "selected" : ""}>SMS</option></select></label>
      <label class="field" data-for="email">Subject<input class="input" name="subject" value="${esc(t?.subject ?? "")}"></label>
      <label class="field">Message<textarea class="input" name="body" rows="6" required>${esc(t?.body ?? "")}</textarea></label>`, async (f) => {
      const body = { name: f.get("name"), channel: f.get("channel"), subject: f.get("subject") || undefined, body: f.get("body") };
      if (t) await api("PATCH", `/api/crm/templates/${t.id}`, body); else await api("POST", "/api/crm/templates", body);
      toast("Template saved");
      renderTemplates();
    });
    const form = S.$("#modal-form");
    const sync = () => { form.querySelector("[data-for=email]").hidden = form.channel.value !== "email"; };
    form.channel.onchange = sync;
    sync();
  };
  S.$("#new-tpl").onclick = () => editor();
  main().querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => editor(list.find((t) => t.id === b.dataset.edit)));
  main().querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
    const t = list.find((x) => x.id === b.dataset.del);
    if (confirm(`Delete the template “${t.name}”?`)) act(async () => { await api("DELETE", `/api/crm/templates/${t.id}`); renderTemplates(); }, "Template deleted");
  });
}

S.view("templates", renderTemplates);
S.view("contacts", renderContacts);
S.view("inbox", renderInbox);
S.view("forms", renderForms);
S.view("calendars", renderCalendars);
S.view("automations", renderAutomations);
S.view("campaigns", renderCampaigns);
S.view("reputation", renderReputation);
S.view("invoices", renderInvoices);
updateInboxBadge();
