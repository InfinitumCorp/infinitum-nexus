// Cumulus://Spreads: a spreadsheet with formulas, several sheets, formats and CSV.
// Saves { sheets: [{ name, cells: { A1: "raw" | { v: "raw", f?: "pct"|"money"|"num2", b?: true } } }] }.
import { el, autosaver, editorBar, saveFile, toast } from "./shared.js";
import { workbook, display, isError, shiftFormula, toCSV, fromCSV, colName, parseRef, refName, rawOf, FUNCTION_NAMES } from "./formula.js";

const MAX_COLS = 702; // A..ZZ
const MAX_ROWS = 100000;

export function open({ root, item, doc, share }) {
  const sheets = doc.sheets;
  let si = 0;
  let wb = workbook(sheets);
  let cur = { c: 0, r: 0 };
  let anchor = { c: 0, r: 0 };
  let editing = null; // { input, ref }
  let clip = null; // { cells: [[raw]], from: {c, r} }

  const cells = () => sheets[si].cells;
  const cellAt = (c, r) => cells()[refName(c, r)];
  const setRaw = (c, r, raw) => {
    const ref = refName(c, r);
    const old = cells()[ref];
    const keep = old && typeof old === "object" ? { f: old.f, b: old.b } : {};
    if (raw === "" && !keep.f && !keep.b) delete cells()[ref];
    else if (keep.f || keep.b) cells()[ref] = Object.fromEntries(Object.entries({ v: raw, ...keep }).filter(([, x]) => x !== undefined));
    else cells()[ref] = raw;
  };
  const setFmt = (c, r, patch) => {
    const ref = refName(c, r);
    const old = cells()[ref];
    const next = { v: rawOf(old), ...(old && typeof old === "object" ? old : {}), ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === false) delete next[k];
    if (!next.f && !next.b) { if (next.v) cells()[ref] = next.v; else delete cells()[ref]; } else cells()[ref] = next;
  };

  const extent = () => {
    let mc = 0, mr = 0;
    for (const ref of Object.keys(cells())) { const p = parseRef(ref); if (p) { mc = Math.max(mc, p.col); mr = Math.max(mr, p.row); } }
    return { cols: Math.min(MAX_COLS, Math.max(26, mc + 6, cur.c + 3)), rows: Math.min(MAX_ROWS, Math.max(100, mr + 30, cur.r + 20)) };
  };
  const sel = () => ({ c1: Math.min(cur.c, anchor.c), c2: Math.max(cur.c, anchor.c), r1: Math.min(cur.r, anchor.r), r2: Math.max(cur.r, anchor.r) });

  /* ---------- chrome ---------- */
  const { bar, status } = editorBar({ item, kind: "spreads", share, extra: [
    el("button", { class: "quiet", onClick: importCSV }, ["Import CSV"]),
    el("button", { class: "quiet", onClick: exportCSV }, ["Download CSV"]),
  ] });
  const saver = autosaver({ id: item.id, version: item.version, status, getDoc: () => ({ sheets }) });

  const tb = (label, title, fn) => el("button", { type: "button", title, "aria-label": title, onMousedown: (e) => e.preventDefault(), onClick: () => { fn(); grid.focus(); } }, [label]);
  const eachSel = (fn) => { const s = sel(); for (let r = s.r1; r <= s.r2; r++) for (let c = s.c1; c <= s.c2; c++) fn(c, r); };
  const fmt = (f) => () => { eachSel((c, r) => setFmt(c, r, { f })); changed(); };
  const toolbar = el("div", { class: "toolbar", role: "toolbar", "aria-label": "Format" }, [
    tb("B", "Bold", () => { const on = !(cellAt(cur.c, cur.r)?.b); eachSel((c, r) => setFmt(c, r, { b: on })); changed(); }),
    el("span", { class: "sep" }),
    tb("$", "Currency", fmt("money")), tb("%", "Percent", fmt("pct")), tb(".00", "Two decimals", fmt("num2")), tb("123", "Plain number", fmt(undefined)),
    el("span", { class: "sep" }),
    tb("Σ", "Sum the cells above", autoSum),
    tb("Fill ↓", "Fill down (Ctrl+D)", fillDown),
    tb("Clear", "Clear cells (Delete)", clearSel),
  ]);
  const refBox = el("div", { class: "ref", "aria-live": "polite" });
  const fx = el("input", { "aria-label": "Formula bar", spellcheck: "false", autocomplete: "off", list: "spreads-fns" });
  const fns = el("datalist", { id: "spreads-fns" }, FUNCTION_NAMES.map((n) => el("option", { value: `=${n}(` })));
  fx.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); const raw = fx.value; grid.focus(); commitRaw(cur.c, cur.r, raw); move(0, 1); }
    if (e.key === "Escape") { grid.focus(); fx.value = rawOf(cellAt(cur.c, cur.r)); }
  });
  const formulaBar = el("div", { class: "formula" }, [refBox, el("span", { class: "fx" }, ["fx"]), fx, fns]);

  const table = el("table", { class: "grid" });
  const grid = el("div", { class: "grid-wrap", tabindex: 0, role: "grid", "aria-label": "Spreadsheet" }, [table]);
  const tabs = el("div", { class: "sheet-tabs", role: "tablist" });
  const stats = el("span", { class: "sel-stats", "aria-live": "polite" });

  /* ---------- drawing ---------- */
  let drawn = { cols: 0, rows: 0 };
  function build() {
    const { cols, rows } = extent();
    drawn = { cols, rows };
    const head = el("tr", {}, [el("th", {}), ...Array.from({ length: cols }, (_, c) => el("th", { dataset: { c } }, [colName(c)]))]);
    const body = el("tbody");
    const frag = document.createDocumentFragment();
    for (let r = 0; r < rows; r++) {
      const tr = el("tr", {}, [el("th", { dataset: { r } }, [String(r + 1)])]);
      for (let c = 0; c < cols; c++) tr.append(el("td", { dataset: { c, r } }));
      frag.append(tr);
    }
    body.append(frag);
    table.replaceChildren(el("thead", {}, [head]), body);
    paint();
  }
  const td = (c, r) => table.tBodies[0]?.rows[r]?.cells[c + 1];
  function paint() {
    wb = workbook(sheets);
    for (const node of table.querySelectorAll("td.num, td.err, td.b")) node.className = "";
    for (const node of table.querySelectorAll("td")) if (node.textContent) node.textContent = "";
    for (const [ref, cell] of Object.entries(cells())) {
      const p = parseRef(ref);
      const node = p && td(p.col, p.row);
      if (!node) continue;
      const v = wb.value(si, ref);
      node.textContent = display(v, typeof cell === "object" ? cell.f : undefined);
      node.className = [typeof v === "number" ? "num" : "", isError(v) ? "err" : "", typeof cell === "object" && cell.b ? "b" : ""].filter(Boolean).join(" ");
      node.title = node.textContent.length > 12 ? node.textContent : "";
    }
    select();
  }
  function select() {
    table.querySelectorAll(".cur, .in-sel, .hl").forEach((n) => n.classList.remove("cur", "in-sel", "hl"));
    const s = sel();
    const multi = s.c1 !== s.c2 || s.r1 !== s.r2;
    let sum = 0, count = 0, filled = 0;
    for (let r = s.r1; r <= Math.min(s.r2, drawn.rows - 1); r++) {
      for (let c = s.c1; c <= Math.min(s.c2, drawn.cols - 1); c++) {
        if (multi) td(c, r)?.classList.add("in-sel");
        const v = cellAt(c, r) != null ? wb.value(si, refName(c, r)) : null;
        if (v != null && v !== "") filled++;
        if (typeof v === "number") { sum += v; count++; }
      }
    }
    td(cur.c, cur.r)?.classList.add("cur");
    for (let c = s.c1; c <= s.c2; c++) table.tHead?.rows[0].cells[c + 1]?.classList.add("hl");
    for (let r = s.r1; r <= s.r2; r++) table.tBodies[0]?.rows[r]?.cells[0]?.classList.add("hl");
    refBox.textContent = multi ? `${refName(s.c1, s.r1)}:${refName(s.c2, s.r2)}` : refName(cur.c, cur.r);
    if (document.activeElement !== fx) fx.value = rawOf(cellAt(cur.c, cur.r));
    stats.textContent = multi && count ? `Sum ${display(sum)} · Average ${display(sum / count)} · Count ${filled}` : multi ? `Count ${filled}` : "";
    td(cur.c, cur.r)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function drawTabs() {
    tabs.replaceChildren(...sheets.map((s, i) => el("button", { role: "tab", "aria-selected": i === si ? "true" : "false",
      onClick: () => { if (i !== si) { stopEdit(true); si = i; cur = { c: 0, r: 0 }; anchor = { ...cur }; drawTabs(); build(); } },
      onDblclick: () => renameSheet(i),
      onContextmenu: (e) => { e.preventDefault(); sheetMenu(i); },
      title: "Double-click to rename, right-click for more",
    }, [s.name])), el("button", { class: "add", "aria-label": "Add sheet", title: "Add sheet", onClick: addSheet }, ["+"]), stats);
  }
  function renameSheet(i) {
    const name = prompt("Sheet name", sheets[i].name)?.trim().slice(0, 60);
    if (!name || name === sheets[i].name) return;
    if (sheets.some((s, j) => j !== i && s.name.toLowerCase() === name.toLowerCase())) return toast("Another sheet has that name.");
    if (!/^[A-Za-z0-9_ ]+$/.test(name)) return toast("Use letters, numbers, spaces and underscores.");
    sheets[i].name = name; drawTabs(); changed();
  }
  function sheetMenu(i) {
    const choice = prompt(`Sheet “${sheets[i].name}”: type rename, duplicate or delete`, "rename")?.trim().toLowerCase();
    if (choice === "rename") renameSheet(i);
    else if (choice === "duplicate") { if (sheets.length >= 50) return toast("A spreadsheet can have 50 sheets."); sheets.splice(i + 1, 0, { name: uniqueName(`${sheets[i].name} copy`), cells: JSON.parse(JSON.stringify(sheets[i].cells)) }); si = i + 1; drawTabs(); build(); changed(); }
    else if (choice === "delete") {
      if (sheets.length === 1) return toast("A spreadsheet needs at least one sheet.");
      if (!confirm(`Delete sheet “${sheets[i].name}”?`)) return;
      sheets.splice(i, 1); si = Math.max(0, Math.min(si, sheets.length - 1)); drawTabs(); build(); changed();
    }
  }
  const uniqueName = (base) => { let n = base.replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 50) || "Sheet", k = 2, name = n; while (sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) name = `${n} ${k++}`; return name; };
  function addSheet() {
    if (sheets.length >= 50) return toast("A spreadsheet can have 50 sheets.");
    sheets.push({ name: uniqueName(`Sheet${sheets.length + 1}`), cells: {} });
    si = sheets.length - 1; cur = { c: 0, r: 0 }; anchor = { ...cur };
    drawTabs(); build(); changed();
  }

  /* ---------- editing ---------- */
  function changed() { paint(); saver.changed(); }
  function commitRaw(c, r, raw) { setRaw(c, r, raw.replace(/\r?\n/g, " ").slice(0, 32000)); const { cols, rows } = extent(); if (cols > drawn.cols || rows > drawn.rows) build(); changed(); }
  function startEdit(initial) {
    if (editing) return;
    const node = td(cur.c, cur.r);
    if (!node) return;
    const box = node.getBoundingClientRect(), host = grid.getBoundingClientRect();
    const input = el("input", { class: "cell-edit", spellcheck: "false", autocomplete: "off", list: "spreads-fns", "aria-label": `Edit ${refName(cur.c, cur.r)}` });
    Object.assign(input.style, { left: `${box.left - host.left + grid.scrollLeft}px`, top: `${box.top - host.top + grid.scrollTop}px`, minWidth: `${box.width}px`, height: `${box.height}px` });
    input.value = initial ?? rawOf(cellAt(cur.c, cur.r));
    editing = { input, c: cur.c, r: cur.r };
    input.addEventListener("input", () => { fx.value = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); stopEdit(true); move(0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Tab") { e.preventDefault(); stopEdit(true); move(e.shiftKey ? -1 : 1, 0); }
      else if (e.key === "Escape") { e.preventDefault(); stopEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener("blur", () => stopEdit(true));
    grid.append(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function stopEdit(commit) {
    if (!editing) return;
    const { input, c, r } = editing;
    editing = null;
    input.remove();
    if (commit && input.value !== rawOf(cellAt(c, r))) commitRaw(c, r, input.value);
    grid.focus();
  }
  function move(dc, dr, extend = false) {
    cur = { c: Math.max(0, Math.min(MAX_COLS - 1, cur.c + dc)), r: Math.max(0, Math.min(MAX_ROWS - 1, cur.r + dr)) };
    if (!extend) anchor = { ...cur };
    if (cur.c >= drawn.cols - 1 || cur.r >= drawn.rows - 1) build(); else select();
  }
  function clearSel() { eachSel((c, r) => { delete cells()[refName(c, r)]; }); changed(); }
  function fillDown() {
    const s = sel();
    if (s.r1 === s.r2) return;
    for (let c = s.c1; c <= s.c2; c++) {
      const top = cellAt(c, s.r1);
      for (let r = s.r1 + 1; r <= s.r2; r++) {
        const raw = rawOf(top);
        const v = raw.startsWith("=") ? shiftFormula(raw, 0, r - s.r1) : raw;
        if (top && typeof top === "object") cells()[refName(c, r)] = { ...top, v }; else if (v) cells()[refName(c, r)] = v; else delete cells()[refName(c, r)];
      }
    }
    changed();
  }
  function autoSum() {
    let r = cur.r - 1;
    while (r >= 0 && typeof wb.value(si, refName(cur.c, r)) !== "number") r--;
    const end = r;
    while (r >= 0 && typeof wb.value(si, refName(cur.c, r)) === "number") r--;
    if (end < 0) return toast("No numbers above this cell.");
    commitRaw(cur.c, cur.r, `=SUM(${refName(cur.c, r + 1)}:${refName(cur.c, end)})`);
  }

  /* ---------- clipboard, CSV ---------- */
  function copy(e, cut) {
    if (editing || document.activeElement === fx) return;
    const s = sel();
    const rows = [];
    for (let r = s.r1; r <= s.r2; r++) { const row = []; for (let c = s.c1; c <= s.c2; c++) row.push(rawOf(cellAt(c, r))); rows.push(row); }
    clip = { cells: rows, from: { c: s.c1, r: s.r1 }, text: rows.map((r) => r.join("\t")).join("\n") };
    e.clipboardData.setData("text/plain", clip.text);
    e.preventDefault();
    if (cut) clearSel();
  }
  function paste(e) {
    if (editing || document.activeElement === fx) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const internal = clip && clip.text === text.replace(/\r\n/g, "\n");
    const rows = internal ? clip.cells : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    rows.forEach((row, dr) => row.forEach((raw, dc) => {
      const c = cur.c + dc, r = cur.r + dr;
      if (c >= MAX_COLS || r >= MAX_ROWS) return;
      setRaw(c, r, internal && raw.startsWith("=") ? shiftFormula(raw, c - (clip.from.c + dc), r - (clip.from.r + dr)) : raw);
    }));
    anchor = { ...cur };
    cur = { c: Math.min(MAX_COLS - 1, cur.c + rows[0].length - 1), r: Math.min(MAX_ROWS - 1, cur.r + rows.length - 1) };
    build(); saver.changed();
  }
  function exportCSV() {
    const { cols, rows } = (() => { let mc = -1, mr = -1; for (const ref of Object.keys(cells())) { const p = parseRef(ref); if (p) { mc = Math.max(mc, p.col); mr = Math.max(mr, p.row); } } return { cols: mc + 1, rows: mr + 1 }; })();
    const out = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => { const cell = cellAt(c, r); return cell == null ? "" : display(wb.value(si, refName(c, r)), typeof cell === "object" ? cell.f : undefined); }));
    saveFile(`${item.name} - ${sheets[si].name}.csv`, toCSV(out), "text/csv");
  }
  function importCSV() {
    const input = el("input", { type: "file", accept: ".csv,text/csv,text/plain" });
    input.onchange = async () => {
      const f = input.files[0];
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) return toast("CSV files can be up to 4 MB.");
      const rows = fromCSV(await f.text());
      if (sheets.length >= 50) return toast("A spreadsheet can have 50 sheets.");
      const sheet = { name: uniqueName(f.name.replace(/\.[^.]+$/, "")), cells: {} };
      rows.slice(0, MAX_ROWS).forEach((row, r) => row.slice(0, MAX_COLS).forEach((v, c) => { if (v !== "") sheet.cells[refName(c, r)] = v; }));
      sheets.push(sheet); si = sheets.length - 1; cur = { c: 0, r: 0 }; anchor = { ...cur };
      drawTabs(); build(); saver.changed();
      toast(`Imported ${rows.length} rows into “${sheet.name}”.`);
    };
    input.click();
  }

  /* ---------- input ---------- */
  grid.addEventListener("keydown", (e) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    if (arrows[e.key]) { e.preventDefault(); const [dc, dr] = arrows[e.key]; move(mod ? dc * 1000 : dc, mod ? dr * 1000 : dr, e.shiftKey); if (mod) { cur = { c: Math.min(cur.c, drawn.cols - 1), r: Math.min(cur.r, drawn.rows - 1) }; if (!e.shiftKey) anchor = { ...cur }; select(); } return; }
    if (e.key === "Tab") { e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); return; }
    if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) move(0, -1); else startEdit(); return; }
    if (e.key === "F2") { e.preventDefault(); startEdit(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); clearSel(); return; }
    if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); fillDown(); return; }
    if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toolbar.querySelector("button").click(); return; }
    if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); anchor = { c: 0, r: 0 }; cur = { c: drawn.cols - 1, r: drawn.rows - 1 }; select(); return; }
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saver.flush(); return; }
    if (!mod && !e.altKey && e.key.length === 1) { e.preventDefault(); startEdit(e.key); }
  });
  grid.addEventListener("copy", (e) => copy(e, false));
  grid.addEventListener("cut", (e) => copy(e, true));
  grid.addEventListener("paste", paste);
  let dragging = false;
  const cellOf = (t) => { const n = t.closest?.("td"); return n ? { c: +n.dataset.c, r: +n.dataset.r } : null; };
  table.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const head = e.target.closest?.("th");
    if (head && head.dataset.c != null) { e.preventDefault(); stopEdit(true); anchor = { c: +head.dataset.c, r: 0 }; cur = { c: +head.dataset.c, r: drawn.rows - 1 }; select(); grid.focus(); return; }
    if (head && head.dataset.r != null) { e.preventDefault(); stopEdit(true); anchor = { c: 0, r: +head.dataset.r }; cur = { c: drawn.cols - 1, r: +head.dataset.r }; select(); grid.focus(); return; }
    const at = cellOf(e.target);
    if (!at) return;
    e.preventDefault();
    // Clicking a cell while typing a formula inserts its reference.
    if (editing && editing.input.value.startsWith("=") && /[=(,+\-*/^&<>:]$/.test(editing.input.value)) { editing.input.value += refName(at.c, at.r); fx.value = editing.input.value; return; }
    stopEdit(true);
    cur = at; if (!e.shiftKey) anchor = { ...at };
    dragging = true; select(); grid.focus();
  });
  table.addEventListener("mouseover", (e) => { if (!dragging) return; const at = cellOf(e.target); if (at) { cur = at; select(); } });
  document.addEventListener("mouseup", () => { dragging = false; });
  table.addEventListener("dblclick", (e) => { if (cellOf(e.target)) startEdit(); });

  root.replaceChildren(bar, toolbar, formulaBar, grid, tabs);
  drawTabs();
  build();
  grid.focus();
}
