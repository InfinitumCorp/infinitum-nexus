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

S.view("inbox", renderInbox);
S.view("forms", renderForms);
S.view("calendars", renderCalendars);
S.view("automations", renderAutomations);
S.view("campaigns", renderCampaigns);
updateInboxBadge();
