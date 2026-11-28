// Public +SPCTR review page. Reads ?t=<token>: a 1–5 rating, the public review link, and a private note.
// Everyone gets the public link, whatever they rate (no "review gating").
(() => {
  const root = document.getElementById("root");
  const token = new URLSearchParams(location.search).get("t") || "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const foot = '<p class="foot">Powered by +SPCTR<sup>™</sup></p>';
  const fail = (msg) => { root.innerHTML = `<p class="muted">${esc(msg)}</p>${foot}`; };
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return fail("This review link isn't valid.");
  const url = `/api/public/reviews/${encodeURIComponent(token)}`;
  const post = (body) => fetch(url, { method: "POST", keepalive: true, headers: { "content-type": "application/json", "x-spectre": "1" }, body: JSON.stringify(body) })
    .then(async (r) => { const out = await r.json(); if (!r.ok) throw new Error(out.error || "Something went wrong. Please try again."); return out; });

  fetch(url).then(async (r) => {
    const p = await r.json();
    if (!r.ok) return fail(p.error || "This review link isn't valid.");
    let rating = p.rating || 0;
    const stars = () => [1, 2, 3, 4, 5].map((n) => `<button type="button" class="star${n <= rating ? " on" : ""}" data-n="${n}" aria-label="${n} star${n > 1 ? "s" : ""}" aria-pressed="${n === rating}">★</button>`).join("");
    const draw = () => {
      root.innerHTML = `
        <h1>${p.firstName ? `${esc(p.firstName)}, how` : "How"} did we do?</h1>
        <p class="lead">Your opinion helps ${esc(p.business)} improve.</p>
        <div class="stars" role="group" aria-label="Your rating">${stars()}</div>
        <div id="after" ${rating ? "" : "hidden"}>
          <p>${rating >= 4 ? "Thank you! Would you share that publicly? It helps others find us." : "Thank you for telling us. You're welcome to leave a public review too."}</p>
          ${p.reviewUrl ? `<p><a class="btn-link" id="public" href="${esc(p.reviewUrl)}" target="_blank" rel="noopener noreferrer">Write a public review</a></p>` : ""}
          <form id="note"><label>Anything we could do better? (private, only ${esc(p.business)} sees it)<textarea name="feedback" maxlength="2000"></textarea></label>
          <div class="error" id="err" role="alert"></div><button>Send privately</button></form>
        </div>${foot}`;
      root.querySelectorAll(".star").forEach((b) => b.onclick = async () => {
        rating = Number(b.dataset.n);
        draw();
        try { await post({ rating }); } catch (e) { const err = document.getElementById("err"); if (err) err.textContent = e.message; }
      });
      document.getElementById("public")?.addEventListener("click", () => { post({ clicked: true }).catch(() => {}); });
      const form = document.getElementById("note");
      form.onsubmit = async (e) => {
        e.preventDefault();
        const text = form.feedback.value.trim();
        if (!text) { document.getElementById("err").textContent = "Write a few words first."; return; }
        form.querySelector("button").disabled = true;
        try { await post({ feedback: text }); form.outerHTML = `<div class="done">Thank you. ${esc(p.business)} will read this.</div>`; }
        catch (ex) { document.getElementById("err").textContent = ex.message; form.querySelector("button").disabled = false; }
      };
    };
    draw();
  }).catch(() => fail("This page couldn't load. Please try again."));
})();
