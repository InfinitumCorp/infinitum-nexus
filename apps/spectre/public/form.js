// Public +SPCTR form. Reads ?f=<formId>, shows its questions, submits to the same origin.
(() => {
  const root = document.getElementById("root");
  const id = new URLSearchParams(location.search).get("f") || "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const foot = '<p class="foot">Powered by +SPCTR<sup>™</sup></p>';
  const fail = (msg) => { root.innerHTML = `<p class="muted">${esc(msg)}</p>${foot}`; };
  if (!/^fm_[0-9a-f-]{36}$/.test(id)) return fail("This form link isn't valid.");

  fetch(`/api/public/forms/${encodeURIComponent(id)}`).then(async (r) => {
    const f = await r.json();
    if (!r.ok) return fail(f.error || "This form isn't available.");
    document.title = f.name;
    const input = (fl) => {
      const req = fl.required ? "required" : "";
      const common = `name="${esc(fl.key)}" ${req} aria-label="${esc(fl.label)}"`;
      if (fl.type === "textarea") return `<textarea ${common} maxlength="5000"></textarea>`;
      if (fl.type === "select") return `<select ${common}><option value="">Choose…</option>${fl.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
      const type = fl.type === "email" ? "email" : fl.type === "phone" ? "tel" : "text";
      const ac = fl.type === "email" ? "email" : fl.type === "phone" ? "tel" : fl.key === "name" ? "name" : "on";
      return `<input type="${type}" autocomplete="${ac}" ${common} maxlength="300">`;
    };
    root.innerHTML = `
      <h1>${esc(f.headline || f.name)}</h1>
      ${f.headline ? `<p class="lead">${esc(f.name)}</p>` : '<div class="gap"></div>'}
      <form id="f" novalidate>
        ${f.fields.map((fl) => `<label>${esc(fl.label)}${fl.required ? ' <span class="req">*</span>' : ""}${input(fl)}</label>`).join("")}
        <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <div class="error" id="err" role="alert"></div>
        <button id="send">Send</button>
      </form>${foot}`;
    const form = document.getElementById("f");
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById("send");
      const err = document.getElementById("err");
      err.textContent = "";
      if (!form.checkValidity()) { err.textContent = "Please fill in the required fields."; return; }
      btn.disabled = true;
      const data = new FormData(form);
      const answers = {};
      for (const fl of f.fields) answers[fl.key] = data.get(fl.key) || "";
      try {
        const r = await fetch(`/api/public/forms/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-spectre": "1" },
          body: JSON.stringify({ answers, website: data.get("website") || "", referrer: document.referrer || undefined }),
        });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error || "Something went wrong. Please try again.");
        root.innerHTML = `<div class="done">${esc(out.message)}</div>${foot}`;
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    };
  }).catch(() => fail("This form couldn't load. Please try again."));
})();
