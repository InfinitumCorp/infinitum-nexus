/* VEIL web app. Classic script so it also runs from file:///android_asset inside the Android app. */
(function () {
  "use strict";
  var TRACKERS = window.VEIL_TRACKERS || [];
  var $ = function (id) { return document.getElementById(id); };

  function stripTrackers(href) {
    var u;
    try { u = new URL(href); } catch (e) { return null; }
    var changed = false;
    TRACKERS.forEach(function (t) {
      if (u.searchParams.has(t)) { u.searchParams.delete(t); changed = true; }
    });
    return changed ? u.toString() : null;
  }
  window.veilStripTrackers = stripTrackers;

  // Inside VEIL for Android (bundled hub) or the Android WebView.
  var inApp = location.protocol === "file:" || /; wv\)/.test(navigator.userAgent);
  if (inApp) {
    $("in-app").hidden = false;
    $("get").hidden = true;
    $("mode-chip").textContent = "Anonymous session";
  }

  // Search box: an address opens with trackers removed; anything else searches DuckDuckGo.
  // Navigates from script because the CSP sets form-action 'none'.
  function looksLikeAddress(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (/^[^\s]+\.[a-z]{2,}(?:[:/?#][^\s]*)?$/i.test(s));
  }
  $("omni").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var q = $("omni").value.trim();
    if (!q) return;
    if (looksLikeAddress(q)) {
      var href = /^[a-z][a-z0-9+.-]*:\/\//i.test(q) ? q : "https://" + q;
      try {
        var u = new URL(href);
        if (u.protocol === "https:" || u.protocol === "http:") {
          location.href = stripTrackers(u.toString()) || u.toString();
          return;
        }
      } catch (err) { /* not a URL: search it */ }
    }
    location.href = "https://duckduckgo.com/?q=" + encodeURIComponent(q);
  });

  $("clean-btn").addEventListener("click", function () {
    var raw = $("link-in").value.trim();
    var out = $("link-out");
    if (!raw) { out.textContent = ""; return; }
    var withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : "https://" + raw;
    var cleaned = stripTrackers(withScheme);
    if (cleaned === null) {
      try { new URL(withScheme); out.textContent = "No tracking parameters found."; }
      catch (e) { out.textContent = "That doesn't look like a link."; }
      $("copy-btn").hidden = true;
      return;
    }
    out.textContent = cleaned;
    $("copy-btn").hidden = !navigator.clipboard;
  });
  $("link-in").addEventListener("keydown", function (e) { if (e.key === "Enter") $("clean-btn").click(); });
  $("copy-btn").addEventListener("click", function () {
    navigator.clipboard.writeText($("link-out").textContent).then(function () {
      $("copy-btn").textContent = "Copied";
      setTimeout(function () { $("copy-btn").textContent = "Copy"; }, 1500);
    });
  });

  if (window.VEIL_BUILD) $("build").textContent = window.VEIL_BUILD;

  if (!inApp && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
