// Suggest the right download for this device, and show each file's version, size and SHA-256.
(() => {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const touchMac = /Mac/.test(platform) && navigator.maxTouchPoints > 1; // iPadOS reports itself as a Mac
  const os =
    /iPhone|iPad|iPod/.test(ua) || touchMac ? "ios"
    : /Android/.test(ua) ? "android"
    : /Win/.test(platform) || /Windows/.test(ua) ? "windows"
    : /Mac/.test(platform) || /Mac OS X/.test(ua) ? "mac"
    : /Linux|X11|CrOS/.test(platform + ua) ? "linux"
    : "web";

  const labels = {
    windows: ["Download for Windows", "get/windows"],
    mac: ["Download for Mac", "get/mac"],
    linux: ["Download for Linux (AppImage)", "get/linux-appimage-x64"],
    android: ["Download for Android", "get/android"],
    ios: ["Add to your iPhone or iPad", "#ios"],
    web: ["Open Cumulus://Mail", "https://mail.cumuluscloud.app/"],
  };
  const card = document.getElementById(os);
  if (card) card.classList.add("current");
  const [label, href] = labels[os];
  const link = document.getElementById("suggest-link");
  link.textContent = label;
  link.href = href;
  document.getElementById("suggest-note").textContent = os === "web" ? "" : "Other platforms are below.";
  document.getElementById("suggest").hidden = false;

  const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  fetch("files/manifest.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : null))
    .then((manifest) => {
      const files = new Map((manifest?.files || []).map((f) => [f.key, f]));
      document.querySelectorAll("[data-key]").forEach((a) => {
        const f = files.get(a.dataset.key);
        if (!f) { a.setAttribute("aria-disabled", "true"); a.title = "Coming soon"; return; }
        a.href = `files/${encodeURIComponent(f.name)}`;
      });
      document.querySelectorAll("[data-meta]").forEach((p) => {
        const f = files.get(p.dataset.meta);
        p.textContent = f ? `Version ${f.version} · ${size(f.size)} · SHA-256 ${f.sha256}` : "Coming soon";
      });
    })
    .catch(() => {});
})();
