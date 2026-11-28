// Public +SPCTR invoice. Reads ?t=<token>. Pay opens the business's own payment page;
// +SPCTR never takes or moves money.
(() => {
  const root = document.getElementById("root");
  const token = new URLSearchParams(location.search).get("t") || "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const foot = '<p class="foot">Powered by +SPCTR<sup>™</sup></p>';
  const fail = (msg) => { root.innerHTML = `<p class="muted">${esc(msg)}</p>${foot}`; };
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return fail("This invoice link isn't valid.");
  const day = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  fetch(`/api/public/invoices/${encodeURIComponent(token)}`).then(async (r) => {
    const v = await r.json();
    if (!r.ok) return fail(v.error || "This invoice link isn't valid.");
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: v.currency });
    const m = (c) => fmt.format(c / 100);
    document.title = `Invoice ${v.number}`;
    root.innerHTML = `
      <div class="inv-head"><div><h1>Invoice ${esc(v.number)}</h1>
        <p class="muted">Issued ${esc(day(v.issueDate))} · Due ${esc(day(v.dueDate))}</p></div>
        ${v.status === "paid" ? `<span class="paid">Paid</span>` : v.status === "void" ? `<span class="void">Void</span>` : ""}</div>
      <div class="parties"><div><div class="muted small">From</div><div class="pre">${esc(v.from || "")}</div></div>
        <div><div class="muted small">To</div><div class="pre">${v.to.map(esc).join("\n")}</div></div></div>
      <table class="lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
        <tbody>${v.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="num">${esc(i.quantity)}</td><td class="num">${m(i.unitCents)}</td><td class="num">${m(Math.round(i.quantity * i.unitCents))}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="3">Subtotal</td><td class="num">${m(v.subtotalCents)}</td></tr>
        ${v.taxRate ? `<tr><td colspan="3">Tax (${esc(v.taxRate)}%)</td><td class="num">${m(v.taxCents)}</td></tr>` : ""}
        <tr class="total"><td colspan="3">Total due</td><td class="num">${m(v.totalCents)}</td></tr></tfoot></table>
      ${v.notes ? `<p class="pre notes">${esc(v.notes)}</p>` : ""}
      <div class="actions">${v.paymentUrl ? `<a class="btn-link" href="${esc(v.paymentUrl)}" target="_blank" rel="noopener noreferrer">Pay ${m(v.totalCents)}</a>` : ""}
        <button class="ghost" id="print" type="button">Print or save as PDF</button></div>
      ${foot}`;
    document.getElementById("print").onclick = () => window.print();
  }).catch(() => fail("This invoice couldn't load. Please try again."));
})();
