/* VEIL search and answers. Classic script so it also runs from file:///android_asset inside
   the Android app. Everything comes from VEIL's server (POST /api/ask streams the answer as
   newline-separated JSON; POST /api/search pages the web results), and is drawn here with
   DOM nodes and textContent only: nothing from a page or the AI runs as code, and the
   person stays on VEIL's page unless they open a source themselves. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var TRACKERS = window.VEIL_TRACKERS || [];
  var inApp = location.protocol === "file:";
  var BASE = inApp ? "https://infinitumveil.app" : "";
  var query = (new URLSearchParams(location.search).get("q") || "").trim();
  var history = [];   // [{ q, a }] earlier turns, for follow-ups
  var busy = false;
  var webQuery = "";  // the query the web results belong to
  var next = null;
  var shown = 0;
  var webFrom = [];   // which sources the web results came from

  if (inApp) $("brand").href = "index.html";

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clean(href) {
    try {
      var u = new URL(href);
      TRACKERS.forEach(function (t) { u.searchParams.delete(t); });
      return u.toString();
    } catch (e) { return href; }
  }

  function safeHref(href) {
    try {
      var u = new URL(href);
      return u.protocol === "https:" || u.protocol === "http:" ? clean(u.toString()) : null;
    } catch (e) { return null; }
  }

  function looksLikeAddress(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (/^[^\s]+\.[a-z]{2,}(?:[:/?#][^\s]*)?$/i.test(s));
  }

  /** The top box: an address opens (trackers removed); anything else is a new question on this page. */
  function go(input) {
    var s = input.trim();
    if (!s) return;
    if (looksLikeAddress(s)) {
      var href = safeHref(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s);
      if (href) { location.href = href; return; }
    }
    location.href = "search.html?q=" + encodeURIComponent(s);
  }

  $("search-form").addEventListener("submit", function (e) { e.preventDefault(); go($("q").value); });

  // ---------------- Answer text: a small, safe Markdown subset ----------------

  /** Inline text: **bold**, `code` and [n] citations, as DOM nodes. */
  function inline(parent, text, sources) {
    var re = /(\*\*[^*]+\*\*|`[^`]+`|\[\d+\](?:\[\d+\])*)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      var tok = m[0];
      if (tok.charAt(0) === "*") parent.appendChild(el("strong", null, tok.slice(2, -2)));
      else if (tok.charAt(0) === "`") parent.appendChild(el("code", null, tok.slice(1, -1)));
      else {
        tok.replace(/\[(\d+)\]/g, function (_, n) {
          var src = sources[Number(n) - 1];
          var href = src && safeHref(src.url);
          if (!href) return "";
          var a = el("a", "cite", n);
          a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.title = src.title + " · " + src.site;
          a.setAttribute("data-n", n);
          parent.appendChild(a);
          return "";
        });
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  /** The whole answer so far as paragraphs, lists, headings and code blocks. */
  function renderAnswer(box, text, sources, writing) {
    box.textContent = "";
    var lines = text.replace(/\r/g, "").split("\n");
    var list = null, listType = "", para = null, code = null;
    function closeAll() { list = null; listType = ""; para = null; }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*```/.test(line)) {
        if (code) { code = null; } else { closeAll(); var pre = el("pre"); code = el("code"); pre.appendChild(code); box.appendChild(pre); }
        continue;
      }
      if (code) { code.textContent += (code.textContent ? "\n" : "") + line; continue; }
      if (!line.trim()) { closeAll(); continue; }
      var h = line.match(/^\s*#{1,4}\s+(.*)$/);
      var ul = line.match(/^\s*[-*•]\s+(.*)$/);
      var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (h) { closeAll(); var hh = el("h3"); inline(hh, h[1], sources); box.appendChild(hh); continue; }
      if (ul || ol) {
        var type = ul ? "ul" : "ol";
        if (!list || listType !== type) { list = el(type); listType = type; box.appendChild(list); }
        para = null;
        var li = el("li"); inline(li, (ul || ol)[1], sources); list.appendChild(li);
        continue;
      }
      list = null;
      if (!para) { para = el("p"); box.appendChild(para); } else para.appendChild(document.createTextNode(" "));
      inline(para, line.trim(), sources);
    }
    if (writing) {
      var tail = box.lastElementChild;
      if (tail && (tail.tagName === "UL" || tail.tagName === "OL")) tail = tail.lastElementChild;
      (tail && tail.tagName !== "PRE" ? tail : box).appendChild(el("span", "caret"));
    }
  }

  // ---------------- One turn: question, sources, answer, related ----------------

  function newTurn(q) {
    var t = { q: q, text: "", sources: [] };
    t.root = el("article", "turn");
    t.root.appendChild(el("h1", "question", q));

    t.srcLabel = el("h2", "label"); t.srcLabel.appendChild(el("span", "dot")); t.srcLabel.appendChild(document.createTextNode("Sources"));
    t.srcBox = el("div", "sources");
    for (var i = 0; i < 4; i++) t.srcBox.appendChild(el("div", "src skel"));
    t.root.appendChild(t.srcLabel); t.root.appendChild(t.srcBox);

    t.ansLabel = el("h2", "label"); t.dot = el("span", "dot busy"); t.ansLabel.appendChild(t.dot);
    t.ansLabel.appendChild(document.createTextNode("Answer"));
    t.answer = el("div", "answer");
    for (var j = 0; j < 3; j++) { var s = el("div", "skel-line"); s.style.width = (92 - j * 18) + "%"; t.answer.appendChild(s); }
    t.root.appendChild(t.ansLabel); t.root.appendChild(t.answer);
    $("thread").appendChild(t.root);
    return t;
  }

  function showSources(t, sources) {
    t.sources = sources;
    t.srcBox.textContent = "";
    if (!sources.length) { t.srcLabel.hidden = true; t.srcBox.hidden = true; return; }
    sources.forEach(function (s) {
      var href = safeHref(s.url);
      if (!href) return;
      var a = el("a", "src");
      a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = s.title;
      a.setAttribute("data-n", String(s.n));
      a.appendChild(el("span", "src-title", s.title));
      var site = el("span", "src-site");
      site.appendChild(el("span", "src-n", String(s.n)));
      site.appendChild(document.createTextNode(s.site));
      a.appendChild(site);
      t.srcBox.appendChild(a);
    });
  }

  // Hovering a citation lights up its source card.
  $("thread").addEventListener("mouseover", function (e) {
    var c = e.target.closest && e.target.closest(".cite");
    var turn = c && c.closest(".turn");
    if (!turn) return;
    Array.prototype.forEach.call(turn.querySelectorAll(".src"), function (s) {
      s.classList.toggle("lit", s.getAttribute("data-n") === c.getAttribute("data-n"));
    });
  });
  $("thread").addEventListener("mouseout", function (e) {
    if (e.target.closest && e.target.closest(".cite")) {
      Array.prototype.forEach.call(document.querySelectorAll(".src.lit"), function (s) { s.classList.remove("lit"); });
    }
  });

  // Touch screens have no hover: the first tap on a citation shows its source card, a second
  // tap on the same citation opens the page.
  var lastPointer = "";
  $("thread").addEventListener("pointerdown", function (e) { lastPointer = e.pointerType || ""; });
  $("thread").addEventListener("click", function (e) {
    var c = e.target.closest && e.target.closest(".cite");
    var turn = c && c.closest(".turn");
    if (!turn || lastPointer !== "touch") return;
    var card = turn.querySelector('.src[data-n="' + c.getAttribute("data-n") + '"]');
    if (!card || card.classList.contains("lit")) return;
    e.preventDefault();
    Array.prototype.forEach.call(document.querySelectorAll(".src.lit"), function (s) { s.classList.remove("lit"); });
    card.classList.add("lit");
    if (card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });

  function finishTurn(t, related) {
    t.dot.className = "dot";
    renderAnswer(t.answer, t.text, t.sources, false);
    var tools = el("div", "tools");
    var copy = el("button", "tool", "Copy");
    copy.type = "button";
    copy.addEventListener("click", function () {
      var plain = t.text + (t.sources.length ? "\n\nSources:\n" + t.sources.map(function (s) { return "[" + s.n + "] " + s.title + " " + s.url; }).join("\n") : "");
      if (navigator.clipboard) navigator.clipboard.writeText(plain).then(function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1500); });
    });
    tools.appendChild(copy);
    t.root.appendChild(tools);
    if (related && related.length) {
      var box = el("div", "related");
      var lab = el("h2", "label"); lab.appendChild(el("span", "dot")); lab.appendChild(document.createTextNode("Related"));
      box.appendChild(lab);
      related.forEach(function (r) {
        var b = el("button", "rel", r);
        b.type = "button";
        b.addEventListener("click", function () { ask(r); });
        box.appendChild(b);
      });
      t.root.appendChild(box);
    }
    if (t.webSlot) t.root.appendChild(t.webSlot);
  }

  function failTurn(t, message) {
    t.dot.className = "dot";
    if (!t.sources.length) { t.srcLabel.hidden = true; t.srcBox.hidden = true; }
    if (!t.text) t.answer.textContent = "";
    else renderAnswer(t.answer, t.text, t.sources, false);
    var n = el("div", "notice", message);
    n.appendChild(el("br"));
    var b = el("button", null, "Try again");
    b.type = "button";
    b.addEventListener("click", function () {
      if (t.webSlot) { $("main").appendChild(t.webSlot); t.webSlot.hidden = true; $("results").textContent = ""; shown = 0; }
      t.root.remove();
      ask(t.q, true);
    });
    n.appendChild(b);
    t.answer.appendChild(n);
    if (t.webSlot) t.root.appendChild(t.webSlot);
  }

  // ---------------- Talking to VEIL ----------------

  /** Reads newline-separated JSON events from a fetch response, calling onEvent for each. */
  function readEvents(res, onEvent) {
    var dec = new TextDecoder();
    var buf = "";
    function feed(chunk) {
      buf += chunk;
      var nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        var line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) { try { onEvent(JSON.parse(line)); } catch (e) { /* skip a broken line */ } }
      }
    }
    if (!res.body || !res.body.getReader) return res.text().then(function (all) { feed(all + "\n"); });
    var reader = res.body.getReader();
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) { feed(dec.decode() + "\n"); return; }
        feed(dec.decode(r.value, { stream: true }));
        return pump();
      });
    }
    return pump();
  }

  function setBusy(on) {
    busy = on;
    $("fsend").disabled = on;
    $("fq").disabled = on;
  }

  /** The question being answered goes in the tab title and the address, so reload and sharing land on it. */
  function showQuery(q) {
    document.title = q + " · VEIL</> Search";
    try {
      var u = new URL(location.href);
      u.searchParams.set("q", q);
      window.history.replaceState(null, "", u.toString()); // `history` here is the follow-up list
    } catch (e) { /* some file:// WebViews refuse; the title still changes */ }
  }

  function ask(q, retry) {
    q = String(q || "").trim();
    if (!q || busy) return;
    setBusy(true);
    $("followup").hidden = false;
    var first = !history.length;
    showQuery(q);
    var t = newTurn(q);
    if (!first || retry) t.root.scrollIntoView({ behavior: "smooth", block: "start" });
    var related = [];
    var failed = null;
    var frame = 0;
    function paint() { frame = 0; renderAnswer(t.answer, t.text, t.sources, true); }

    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 90000);
    fetch(BASE + "/api/ask", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ q: q, history: history }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return readEvents(res, function (ev) {
        if (ev.type === "sources") showSources(t, ev.sources || []);
        else if (ev.type === "results" && first) showResults(q, ev, t);
        else if (ev.type === "text") { t.text += ev.t; if (!frame) frame = requestAnimationFrame(paint); }
        else if (ev.type === "related") related = ev.questions || [];
        else if (ev.type === "error") failed = ev.message || "Something went wrong.";
      });
    }).then(function () {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      if (failed) failTurn(t, failed);
      else if (!t.text) failTurn(t, "No answer came back. Try again.");
      else { finishTurn(t, related); history.push({ q: q, a: t.text }); if (history.length > 3) history.shift(); }
    }).catch(function () {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      failTurn(t, inApp ? "Couldn't reach VEIL. If Tor is still connecting, wait for ● Tor and try again." : "Couldn't reach VEIL. Check your connection and try again.");
    }).then(function () {
      clearTimeout(timer);
      setBusy(false);
    });
  }

  $("followup-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var v = $("fq").value.trim();
    if (!v || busy) return;
    $("fq").value = "";
    ask(v);
  });

  // ---------------- Web results (under the first answer) ----------------

  var NAMES = { veil: "VEIL index", yandex: "Yandex", brave: "Brave", mojeek: "Mojeek", hackernews: "Hacker News", stackoverflow: "Stack Overflow" };
  function sourceName(s) { return NAMES[s] || s; }

  function siteLabel(href) {
    try {
      var u = new URL(href);
      var path = u.pathname.replace(/\/$/, "");
      return u.hostname.replace(/^www\./, "") + (path ? " › " + decodeURIComponent(path.split("/").filter(Boolean).slice(0, 2).join(" › ")) : "");
    } catch (e) { return href; }
  }

  function renderResults(results) {
    var box = $("results");
    results.forEach(function (r) {
      var href = safeHref(r.url);
      if (!href) return;
      var item = el("article", "result");
      item.appendChild(el("span", "site", siteLabel(href) + (r.sources && r.sources.length ? "  ·  " + r.sources.map(sourceName).join(", ") : "")));
      var a = el("a", "title", r.title);
      a.href = href; a.rel = "noreferrer";
      item.appendChild(a);
      if (r.snippet) item.appendChild(el("p", "snippet", r.snippet));
      box.appendChild(item);
      shown++;
    });
    updateMeta();
  }

  /** The web results belong to the first question: they sit at the end of its turn, above any follow-ups. */
  function showResults(q, data, turn) {
    webQuery = q;
    var results = data.results || [];
    if (!results.length) return;
    turn.webSlot = $("web");
    $("web").hidden = false;
    webFrom = data.from || [];
    renderResults(results);
    next = data.next || null;
    $("more").hidden = !next;
  }

  function updateMeta() {
    var from = webFrom.map(sourceName).join(", ");
    $("meta").textContent = "Private search · " + shown + " results" + (from ? " from " + from : "") +
      (webFrom.indexOf("stackoverflow") >= 0 ? " (Stack Overflow content is CC BY-SA)" : "");
  }

  $("more").addEventListener("click", function () {
    if (!next) return;
    var btn = $("more");
    btn.disabled = true;
    btn.textContent = "Loading…";
    fetch(BASE + "/api/search", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ q: webQuery, next: next }),
      credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    }).then(function (res) {
      if (!res.ok) throw new Error("status " + res.status);
      return res.json();
    }).then(function (data) {
      renderResults(data.results || []);
      next = data.next || null;
      btn.hidden = !next;
      btn.textContent = "More results";
    }).catch(function () {
      btn.textContent = "Couldn't load more. Try again"; // the button stays, so they can
    }).then(function () { btn.disabled = false; });
  });

  // ---------------- Start ----------------

  $("q").value = query;
  if (query) {
    document.title = query + " · VEIL</> Search";
    ask(query);
  } else {
    $("q").focus();
  }
})();
