// Public +SPCTR booking page. Reads ?c=<calendarId>. Times are shown in the visitor's own time zone.
(() => {
  const root = document.getElementById("root");
  const id = new URLSearchParams(location.search).get("c") || "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const foot = '<p class="foot">Powered by +SPCTR<sup>™</sup></p>';
  const fail = (msg) => { root.innerHTML = `<p class="muted">${esc(msg)}</p>${foot}`; };
  if (!/^cal_[0-9a-f-]{36}$/.test(id)) return fail("This booking link isn't valid.");
  const dayKey = (iso) => new Date(iso).toLocaleDateString("en-CA", { timeZone: zone }); // YYYY-MM-DD
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: zone });
  const longDate = (iso) => new Date(iso).toLocaleString([], { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: zone });

  let cal, day, slot;
  const load = async () => {
    const r = await fetch(`/api/public/calendars/${encodeURIComponent(id)}?days=21`);
    const data = await r.json();
    if (!r.ok) return fail(data.error || "This booking page isn't available.");
    cal = data;
    document.title = cal.name;
    const days = [...new Set(cal.slots.map(dayKey))];
    day = days.includes(day) ? day : days[0];
    render(days);
  };

  const render = (days) => {
    if (!days.length) {
      root.innerHTML = `<h1>${esc(cal.name)}</h1><p class="muted">No times are open in the next three weeks. Please check back later.</p>${foot}`;
      return;
    }
    const slots = cal.slots.filter((s) => dayKey(s) === day);
    root.innerHTML = `
      <h1>${esc(cal.name)}</h1>
      <p class="lead">${cal.durationMin} minutes${cal.description ? ` · ${esc(cal.description)}` : ""}<br><span class="muted">Times shown in ${esc(zone.replace(/_/g, " "))}</span></p>
      <div class="days" role="tablist">${days.map((d) => {
        const dt = new Date(`${d}T12:00:00`);
        return `<button class="day${d === day ? " active" : ""}" data-day="${d}" role="tab" aria-selected="${d === day}">${dt.toLocaleDateString([], { weekday: "short" })}<b>${dt.getDate()}</b>${dt.toLocaleDateString([], { month: "short" })}</button>`;
      }).join("")}</div>
      <div class="slots">${slots.map((s) => `<button class="slot${s === slot ? " active" : ""}" data-slot="${s}">${time(s)}</button>`).join("")}</div>
      ${slot ? `<form id="f" novalidate>
        <p><b>${esc(longDate(slot))}</b></p>
        <label>Name <span class="req">*</span><input name="name" autocomplete="name" required maxlength="120"></label>
        <label>Email<input name="email" type="email" autocomplete="email" maxlength="200"></label>
        <label>Phone<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
        <label>Anything we should know?<textarea name="notes" maxlength="2000"></textarea></label>
        <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <div class="error" id="err" role="alert"></div>
        <button id="go">Confirm booking</button>
      </form>` : `<p class="muted">Pick a time.</p>`}
      ${foot}`;
    root.querySelectorAll("[data-day]").forEach((b) => b.onclick = () => { day = b.dataset.day; slot = undefined; render(days); });
    root.querySelectorAll("[data-slot]").forEach((b) => b.onclick = () => { slot = b.dataset.slot; render(days); document.querySelector("#f input")?.focus(); });
    const f = document.getElementById("f");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const err = document.getElementById("err");
      const d = new FormData(f);
      if (!String(d.get("name")).trim()) { err.textContent = "Please tell us your name."; return; }
      if (!String(d.get("email")).trim() && !String(d.get("phone")).trim()) { err.textContent = "Please leave an email address or phone number."; return; }
      const btn = document.getElementById("go");
      btn.disabled = true;
      try {
        const r = await fetch(`/api/public/calendars/${encodeURIComponent(id)}/book`, {
          method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" },
          body: JSON.stringify({ start: slot, name: d.get("name"), email: d.get("email"), phone: d.get("phone"), notes: d.get("notes"), website: d.get("website") }),
        });
        const out = await r.json();
        if (r.status === 409) { slot = undefined; await load(); document.getElementById("root").insertAdjacentHTML("afterbegin", `<p class="error">${esc(out.error)}</p>`); return; }
        if (!r.ok) throw new Error(out.error || "Couldn't book that time.");
        const url = URL.createObjectURL(new Blob([out.ics], { type: "text/calendar" }));
        root.innerHTML = `<div class="done"><p>You're booked.</p><p><b>${esc(out.name)}</b><br>${esc(longDate(out.start))}</p>
          <p><a class="muted" href="${url}" download="booking.ics">Add to your calendar</a></p></div>${foot}`;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    };
  };
  load().catch(() => fail("This booking page couldn't load. Please try again."));
})();
