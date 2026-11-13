// Cumulus://Dox: a rich-text document editor. Saves sanitized HTML as { html }.
import { el, autosaver, editorBar, sanitize, saveFile, escapeHtml, toast } from "./shared.js";

const exec = (cmd, value = null) => document.execCommand(cmd, false, value);

export function open({ root, item, doc, share }) {
  const page = el("div", { class: "page", contenteditable: "true", spellcheck: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Document" });
  page.innerHTML = sanitize(doc.html || "");
  try { document.execCommand("styleWithCSS", false, false); document.execCommand("defaultParagraphSeparator", false, "p"); } catch {}

  const count = el("div", { class: "dox-count", "aria-live": "off" });
  const recount = () => { const words = (page.innerText.match(/\S+/g) || []).length; count.textContent = words === 1 ? "1 word" : `${words} words`; };

  const exportHtml = () => saveFile(`${item.name}.html`, `<!doctype html><meta charset="utf-8"><title>${escapeHtml(item.name)}</title><body style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:48px auto;line-height:1.6">${sanitize(page.innerHTML)}</body>`, "text/html");
  const exportText = () => saveFile(`${item.name}.txt`, page.innerText, "text/plain");
  const { bar, status } = editorBar({ item, kind: "dox", share, extra: [
    el("button", { class: "quiet", onClick: () => window.print(), title: "Print or save as PDF" }, ["Print / PDF"]),
    el("button", { class: "quiet", onClick: exportHtml }, ["Download .html"]),
    el("button", { class: "quiet", onClick: exportText }, ["Download .txt"]),
  ] });
  const saver = autosaver({ id: item.id, version: item.version, status, getDoc: () => ({ html: sanitize(page.innerHTML) }) });

  const btn = (label, title, fn, key) => el("button", { type: "button", title: key ? `${title} (${key})` : title, "aria-label": title, onMousedown: (e) => e.preventDefault(), onClick: () => { fn(); page.focus(); changed(); } }, [label]);
  const block = el("select", { "aria-label": "Text style", onChange: () => { exec("formatBlock", block.value); page.focus(); changed(); } }, [
    ["P", "Normal text"], ["H1", "Title"], ["H2", "Heading"], ["H3", "Subheading"], ["BLOCKQUOTE", "Quote"], ["PRE", "Code"],
  ].map(([v, l]) => el("option", { value: v }, [l])));
  const color = el("input", { type: "color", value: "#111820", "aria-label": "Text color", title: "Text color", onInput: () => { exec("foreColor", color.value); changed(); } });
  const align = (a) => () => {
    const sel = getSelection();
    let n = sel?.anchorNode;
    while (n && n !== page && !(n.nodeType === 1 && /^(P|H1|H2|H3|H4|LI|BLOCKQUOTE|DIV|PRE)$/.test(n.tagName))) n = n.parentNode;
    if (n && n !== page) { if (a === "left") n.removeAttribute("data-align"); else n.setAttribute("data-align", a); }
  };
  const link = () => {
    const url = prompt("Link to (https://…)", "https://");
    if (!url || !/^(https?:|mailto:)/i.test(url)) return;
    exec("createLink", url);
  };
  const image = () => {
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
    input.onchange = () => {
      const f = input.files[0];
      if (!f) return;
      if (f.size > 1.5 * 1024 * 1024) return toast("Images in a document can be up to 1.5 MB.");
      const r = new FileReader();
      r.onload = () => { page.focus(); exec("insertImage", r.result); changed(); };
      r.readAsDataURL(f);
    };
    input.click();
  };
  const table = () => {
    const size = prompt("Table size (columns x rows)", "3x3");
    const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(size || "");
    if (!m) return;
    const cols = Math.min(+m[1], 12), rows = Math.min(+m[2], 50);
    exec("insertHTML", `<table><tbody>${`<tr>${"<td><br></td>".repeat(cols)}</tr>`.repeat(rows)}</tbody></table><p><br></p>`);
  };

  const toolbar = el("div", { class: "toolbar", role: "toolbar", "aria-label": "Formatting" }, [
    btn("↶", "Undo", () => exec("undo"), "Ctrl+Z"), btn("↷", "Redo", () => exec("redo"), "Ctrl+Y"), el("span", { class: "sep" }),
    block, el("span", { class: "sep" }),
    btn("B", "Bold", () => exec("bold"), "Ctrl+B"), btn("I", "Italic", () => exec("italic"), "Ctrl+I"), btn("U", "Underline", () => exec("underline"), "Ctrl+U"), btn("S", "Strikethrough", () => exec("strikeThrough")),
    color, btn("▮", "Highlight", () => { const t = getSelection()?.toString(); if (t) exec("insertHTML", `<mark>${escapeHtml(t)}</mark>`); }), el("span", { class: "sep" }),
    btn("⇤", "Align left", align("left")), btn("↔", "Center", align("center")), btn("⇥", "Align right", align("right")), btn("≡", "Justify", align("justify")), el("span", { class: "sep" }),
    btn("• List", "Bulleted list", () => exec("insertUnorderedList")), btn("1. List", "Numbered list", () => exec("insertOrderedList")),
    btn("→", "Indent", () => exec("indent")), btn("←", "Outdent", () => exec("outdent")), el("span", { class: "sep" }),
    btn("Link", "Insert link", link, "Ctrl+K"), btn("Image", "Insert image", image), btn("Table", "Insert table", table), btn("—", "Horizontal line", () => exec("insertHorizontalRule")),
    btn("Tx", "Clear formatting", () => exec("removeFormat")),
  ]);

  function changed() { recount(); saver.changed(); }
  page.addEventListener("input", changed);
  page.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); link(); changed(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saver.flush(); }
  });
  // Paste keeps structure but drops anything unsafe.
  page.addEventListener("paste", (e) => {
    const html = e.clipboardData?.getData("text/html");
    if (!html) return;
    e.preventDefault();
    exec("insertHTML", sanitize(html.replace(/<!--[\s\S]*?-->/g, "")));
  });
  page.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) e.preventDefault(); });
  page.addEventListener("click", (e) => { const a = e.target.closest?.("a"); if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, "_blank", "noopener"); });
  document.addEventListener("selectionchange", () => {
    if (!page.contains(getSelection()?.anchorNode)) return;
    const v = String(document.queryCommandValue("formatBlock") || "P").toUpperCase().replace(/[<>]/g, "");
    block.value = ["H1", "H2", "H3", "BLOCKQUOTE", "PRE"].includes(v) ? v : "P";
  });

  root.replaceChildren(bar, toolbar, el("div", { class: "dox-scroll" }, [page]), count);
  recount();
  page.focus();
  if (!page.textContent.trim() && !page.querySelector("img, table, hr")) {
    // A new document: start typing inside a real paragraph.
    page.innerHTML = "<p><br></p>";
    const range = document.createRange();
    range.setStart(page.firstChild, 0);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
}
