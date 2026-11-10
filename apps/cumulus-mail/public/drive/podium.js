// Cumulus://Podium: presentations. Saves { theme, slides: [{ layout, title, body, image?, notes?, theme? }] }.
import { el, autosaver, editorBar, toast } from "./shared.js";

const LAYOUTS = [["title", "Title slide"], ["content", "Title and text"], ["bullets", "Title and bullets"], ["two", "Two columns"], ["section", "Section header"], ["image", "Title and image"]];
const THEMES = [["paper", "Paper"], ["mist", "Mist"], ["ink", "Ink"], ["blue", "Blue"]];

/** Renders one slide as plain DOM (text only, never HTML from the document). */
export function renderSlide(s, deckTheme) {
  const theme = s.theme || deckTheme || "paper";
  const node = el("div", { class: `slide ${s.layout || "content"} t-${theme}` });
  const title = el("h2", {}, [s.title || (s.layout === "title" ? "Click to add a title" : "")]);
  if (!s.title) title.style.opacity = ".35";
  node.append(title);
  const body = s.body || "";
  if (s.layout === "bullets") node.append(el("ul", { class: "body" }, body.split("\n").filter((l) => l.trim()).map((l) => el("li", {}, [l.replace(/^[-•*]\s*/, "")]))));
  else if (s.layout === "two") { const [a, b = ""] = body.split(/\n-{3,}\n/); node.append(el("div", { class: "body" }, [a]), el("div", { class: "body" }, [b])); }
  else if (body) node.append(el("div", { class: "body" }, [body]));
  if (s.image && /^data:image\/(png|jpeg|gif|webp);/.test(s.image)) node.append(el("img", { src: s.image, alt: "" }));
  return node;
}

export function open({ root, item, doc, share }) {
  const deck = { theme: doc.theme || "paper", slides: doc.slides };
  let at = 0;

  const present = (from = at) => {
    let i = from;
    const box = el("div", { class: "stage-box" });
    const count = el("div", { class: "count" });
    const layer = el("div", { class: "present", tabindex: 0, role: "dialog", "aria-label": "Presentation" }, [box, count]);
    const draw = () => { box.replaceChildren(renderSlide(deck.slides[i], deck.theme)); count.textContent = `${i + 1} / ${deck.slides.length}`; };
    const go = (d) => { i = Math.max(0, Math.min(deck.slides.length - 1, i + d)); draw(); };
    const close = () => { layer.remove(); document.removeEventListener("keydown", keys); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); };
    const keys = (e) => {
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); go(1); }
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); go(-1); }
      else if (e.key === "Home") go(-1e6); else if (e.key === "End") go(1e6);
      else if (e.key === "Escape") close();
    };
    layer.addEventListener("click", (e) => go(e.clientX < innerWidth / 3 ? -1 : 1));
    document.addEventListener("keydown", keys);
    document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement && layer.isConnected) close(); }, { once: false });
    document.body.append(layer);
    layer.requestFullscreen?.().catch(() => {});
    layer.focus();
    draw();
  };

  const printSlides = el("div", { class: "print-slides" });
  const { bar, status } = editorBar({ item, kind: "podium", share, extra: [
    el("button", { class: "quiet", onClick: () => { printSlides.replaceChildren(...deck.slides.map((s) => el("div", { class: "stage-box" }, [renderSlide(s, deck.theme)]))); window.print(); }, title: "Print or save as PDF" }, ["Print / PDF"]),
    el("button", { class: "outline", onClick: () => present(0) }, ["Present"]),
  ] });
  const saver = autosaver({ id: item.id, version: item.version, status, getDoc: () => deck });

  const thumbs = el("nav", { class: "thumbs", "aria-label": "Slides" });
  const stage = el("div", { class: "stage-box" });
  const fields = el("aside", { class: "slide-fields", "aria-label": "Slide" });

  const changed = (redrawThumbs = true) => { stage.replaceChildren(renderSlide(deck.slides[at], deck.theme)); if (redrawThumbs) drawThumbs(); saver.changed(); };
  function drawThumbs() {
    thumbs.replaceChildren(...deck.slides.map((s, i) => el("button", { class: "thumb", "aria-current": i === at ? "true" : "false", "aria-label": `Slide ${i + 1}: ${s.title || "untitled"}`, draggable: "true",
      onClick: () => { at = i; drawAll(); },
      onDragstart: (e) => e.dataTransfer.setData("text/x-slide", String(i)),
      onDragover: (e) => e.preventDefault(),
      onDrop: (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData("text/x-slide")); if (Number.isNaN(from) || from === i) return; const [s2] = deck.slides.splice(from, 1); deck.slides.splice(i, 0, s2); at = i; drawAll(); saver.changed(); },
    }, [el("span", { class: "n" }, [String(i + 1)]), el("div", { class: "mini" }, [renderSlide(s, deck.theme)])])),
    el("button", { class: "outline", onClick: () => addSlide() }, ["+ New slide"]));
  }
  function addSlide(copy) {
    if (deck.slides.length >= 500) return toast("A presentation can have 500 slides.");
    deck.slides.splice(at + 1, 0, copy ? JSON.parse(JSON.stringify(copy)) : { layout: "bullets", title: "", body: "" });
    at += 1; drawAll(); saver.changed();
  }
  function drawFields() {
    const s = deck.slides[at];
    const field = (label, node) => el("label", {}, [label, node]);
    const title = el("input", { value: s.title, maxlength: 300, onInput: () => { s.title = title.value; changed(); } });
    const body = el("textarea", { maxlength: 8000, onInput: () => { s.body = body.value; changed(); } });
    body.value = s.body;
    const notes = el("textarea", { class: "notes", maxlength: 8000, onInput: () => { s.notes = notes.value; saver.changed(); } });
    notes.value = s.notes || "";
    const layout = el("select", { onChange: () => { s.layout = layout.value; drawAll(); saver.changed(); } }, LAYOUTS.map(([v, l]) => el("option", { value: v }, [l])));
    layout.value = s.layout || "content";
    const theme = el("select", { onChange: () => { deck.theme = theme.value; drawAll(); saver.changed(); } }, THEMES.map(([v, l]) => el("option", { value: v }, [l])));
    theme.value = deck.theme;
    const hint = s.layout === "bullets" ? "One bullet per line." : s.layout === "two" ? "Put a line with --- between the two columns." : "";
    const image = el("div", { class: "row" }, [
      el("button", { class: "outline", onClick: () => {
        const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
        input.onchange = () => { const f = input.files[0]; if (!f) return; if (f.size > 1.5 * 1024 * 1024) return toast("Slide images can be up to 1.5 MB."); const r = new FileReader(); r.onload = () => { s.image = r.result; if (s.layout !== "image") s.layout = "image"; drawAll(); saver.changed(); }; r.readAsDataURL(f); };
        input.click();
      } }, [s.image ? "Replace image" : "Add image"]),
      s.image ? el("button", { class: "quiet", onClick: () => { delete s.image; drawAll(); saver.changed(); } }, ["Remove image"]) : null,
    ]);
    fields.replaceChildren(
      field("Layout", layout),
      field("Title", title),
      field("Text", body), hint ? el("p", { class: "muted" }, [hint]) : null,
      image,
      field("Speaker notes", notes),
      field("Theme (whole presentation)", theme),
      el("div", { class: "row" }, [
        el("button", { class: "outline", onClick: () => addSlide(s) }, ["Duplicate"]),
        el("button", { class: "outline", disabled: at === 0, onClick: () => { [deck.slides[at - 1], deck.slides[at]] = [deck.slides[at], deck.slides[at - 1]]; at--; drawAll(); saver.changed(); } }, ["Move up"]),
        el("button", { class: "outline", disabled: at === deck.slides.length - 1, onClick: () => { [deck.slides[at + 1], deck.slides[at]] = [deck.slides[at], deck.slides[at + 1]]; at++; drawAll(); saver.changed(); } }, ["Move down"]),
        el("button", { class: "quiet bad", disabled: deck.slides.length === 1, onClick: () => { const gone = deck.slides.splice(at, 1)[0]; const where = at; at = Math.min(at, deck.slides.length - 1); drawAll(); saver.changed(); toast("Slide deleted", { label: "Undo", run: () => { deck.slides.splice(where, 0, gone); at = where; drawAll(); saver.changed(); } }); } }, ["Delete slide"]),
      ]),
    );
  }
  function drawAll() { stage.replaceChildren(renderSlide(deck.slides[at], deck.theme)); drawThumbs(); drawFields(); }

  document.addEventListener("keydown", (e) => {
    if (!root.contains(thumbs)) return;
    if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key === "Enter")) { e.preventDefault(); present(e.shiftKey ? at : 0); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saver.flush(); }
    if (e.target === document.body && (e.key === "ArrowDown" || e.key === "ArrowUp")) { at = Math.max(0, Math.min(deck.slides.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))); drawAll(); }
  });

  root.replaceChildren(bar, el("div", { class: "podium" }, [thumbs, el("div", { class: "stage" }, [stage]), fields]), printSlides);
  drawAll();
}
