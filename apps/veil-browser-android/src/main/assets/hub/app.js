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
    $("mode-chip").textContent = "Anonymous";
    $("mode-chip").title = "Anonymous session: nothing is kept when you close it";
    $("brand").href = "index.html"; // "./" is a directory inside file:///android_asset
    Array.prototype.forEach.call(document.querySelectorAll(".web-only"), function (el) { el.hidden = true; });
    // In the app, Infinitum apps open in VEIL's side panel instead of a new tab.
    Array.prototype.forEach.call(document.querySelectorAll("a[data-panel]"), function (a) {
      a.removeAttribute("target");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        location.href = "veil-panel://open?u=" + encodeURIComponent(a.href) + "&t=" + encodeURIComponent(a.textContent.trim());
      });
    });
  }

  // Apps menu and the privacy note open in place.
  function toggle(buttonId, panelId, onOpen) {
    var button = $(buttonId), panel = $(panelId);
    button.addEventListener("click", function (e) {
      e.stopPropagation();
      var open = panel.hidden;
      panel.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open && onOpen) onOpen();
    });
  }
  // Apps and Sign In are drop-down menus; opening one closes the other.
  var menus = [["apps-button", "apps-panel"], ["signin", "signin-panel"]];
  function closeMenus(except) {
    menus.forEach(function (m) {
      if (m[1] === except) return;
      $(m[1]).hidden = true; $(m[0]).setAttribute("aria-expanded", "false");
    });
  }
  menus.forEach(function (m) { toggle(m[0], m[1], function () { closeMenus(m[1]); }); });
  toggle("privacy-toggle", "privacy", function () { $("privacy").scrollIntoView({ block: "nearest" }); });
  document.addEventListener("click", function (e) {
    var inside = menus.filter(function (m) { return $(m[1]).contains(e.target); })[0];
    closeMenus(inside ? inside[1] : null);
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeMenus(); });
  $("search-form").addEventListener("submit", function (e) { e.preventDefault(); });

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

  if (window.VEIL_BUILD) $("build").textContent = window.VEIL_BUILD;

  if (!inApp && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
