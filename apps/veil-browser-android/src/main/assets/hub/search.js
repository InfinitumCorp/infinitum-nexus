/* VEIL search results. Classic script so it also runs from file:///android_asset inside the
   Android app. Results come from VEIL's server (POST /api/search, the query in the body), and
   are drawn here with textContent only: nothing from the results page runs as code. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var TRACKERS = window.VEIL_TRACKERS || [];
  var inApp = location.protocol === "file:";
  var API = (inApp ? "https://infinitumveil.app" : "") + "/api/search";
  var query = (new URLSearchParams(location.search).get("q") || "").trim();
  var next = null;
  var busy = false;
  var shown = 0;

  if (inApp) $("brand").href = "index.html";

  function clean(href) {
    try {
      var u = new URL(href);
      TRACKERS.forEach(function (t) { u.searchParams.delete(t); });
      return u.toString();
    } catch (e) { return href; }
  }

  function looksLikeAddress(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (/^[^\s]+\.[a-z]{2,}(?:[:/?#][^\s]*)?$/i.test(s));
  }

  function go(input) {
    var s = input.trim();
    if (!s) return;
    if (looksLikeAddress(s)) {
      var href = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : "https://" + s;
      try {
        var u = new URL(href);
        if (u.protocol === "https:" || u.protocol === "http:") { location.href = clean(u.toString()); return; }
      } catch (e) { /* not a URL: search it */ }
    }
    location.href = "search.html?q=" + encodeURIComponent(s);
  }

  $("search-form").addEventListener("submit", function (e) { e.preventDefault(); go($("q").value); });
  $("q").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); go($("q").value); } });

  function siteLabel(href) {
    try {
      var u = new URL(href);
      var path = u.pathname.replace(/\/$/, "");
      return u.hostname.replace(/^www\./, "") + (path ? " › " + decodeURIComponent(path.split("/").filter(Boolean).slice(0, 2).join(" › ")) : "");
    } catch (e) { return href; }
  }

  function render(results) {
    var box = $("results");
    results.forEach(function (r) {
      var href = clean(r.url);
      var item = document.createElement("article");
      item.className = "result";
      var site = document.createElement("span");
      site.className = "site";
      site.textContent = siteLabel(href);
      var a = document.createElement("a");
      a.className = "title";
      a.href = href;
      a.rel = "noreferrer";
      a.textContent = r.title;
      item.appendChild(site);
      item.appendChild(a);
      if (r.snippet) {
        var p = document.createElement("p");
        p.className = "snippet";
        p.textContent = r.snippet;
        item.appendChild(p);
      }
      box.appendChild(item);
    });
    shown += results.length;
  }

  function notice(message, retry) {
    var div = document.createElement("div");
    div.className = "notice";
    div.textContent = message;
    if (retry) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = "Try again";
      b.addEventListener("click", function () { div.remove(); load(); });
      div.appendChild(document.createElement("br"));
      div.appendChild(b);
    }
    $("results").appendChild(div);
  }

  function skeletons(on) {
    var box = $("results");
    Array.prototype.forEach.call(box.querySelectorAll(".skeleton"), function (s) { s.remove(); });
    if (on) for (var i = 0; i < (shown ? 2 : 5); i++) { var s = document.createElement("div"); s.className = "skeleton"; box.appendChild(s); }
  }

  function load() {
    if (busy) return;
    busy = true;
    $("more").hidden = true;
    skeletons(true);
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: JSON.stringify({ q: query, next: next }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return { error: "Search didn't answer properly. Try again." }; });
    }).then(function (data) {
      skeletons(false);
      if (data.error) { notice(data.error, true); return; }
      if (!shown && !data.results.length) { notice("No results for “" + query + "”."); return; }
      render(data.results);
      $("meta").hidden = false;
      $("meta").textContent = data.source === "wikipedia"
        ? "Private search · " + shown + " results from Wikipedia (CC BY-SA)"
        : "Private search · " + shown + " results";
      next = data.next || null;
      $("more").hidden = !next;
    }).catch(function () {
      skeletons(false);
      notice(inApp ? "Couldn't reach search. If Tor is still connecting, wait for ● Tor and try again." : "Couldn't reach search. Check your connection and try again.", true);
    }).then(function () { clearTimeout(timer); busy = false; });
  }

  $("more").addEventListener("click", load);

  $("q").value = query;
  if (query) {
    document.title = query + " · VEIL</> Search";
    load();
  } else {
    $("q").focus();
  }
})();
