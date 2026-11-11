// Cumulus Mail desktop app: a native window for https://mail.cumuluscloud.app.
// It talks to Cumulus://Mail directly. The CloudFront mirror is an optional fallback, never required.
const { app, BrowserWindow, Menu, shell, ipcMain, session, nativeImage } = require("electron");
const { createHash, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PRIMARY, isOurOrigin, pickOrigin, parseAppLink, linkFromArgv, unreadFromTitle } = require("./origins.js");

const PARTITION = "persist:cumulus-mail";
const SIGNIN_TTL_MS = 10 * 60_000;
let win = null;
let origin = PRIMARY;
let pendingLink = linkFromArgv(process.argv);
let signin = null; // { verifier, at } while a browser sign-in is under way
let retryTimer = null;
let lastLoadError = "";

// One app instance; links opened while it runs go to the open window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    const link = linkFromArgv(argv);
    if (link) handleLink(link);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}
app.on("open-url", (e, link) => { e.preventDefault(); handleLink(link); }); // macOS

// Register as the handler for cumulus-mail:// (sign-in) links. mailto: is offered, never forced:
// the OS asks the person, or they pick Cumulus Mail in their default-apps settings.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient("cumulus-mail", process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient("cumulus-mail");
}

/* ---------------- Window ---------------- */

const stateFile = () => path.join(app.getPath("userData"), "window.json");
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(stateFile(), "utf8")); } catch { return { width: 1280, height: 820 }; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
}

function createWindow() {
  const bounds = loadBounds();
  win = new BrowserWindow({
    ...bounds,
    minWidth: 380,
    minHeight: 520,
    title: "Cumulus://Mail™",
    icon: nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")),
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
    },
  });
  if (bounds.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", saveBounds);

  const wc = win.webContents;
  // Stay on Cumulus://Mail; every other link opens in the person's browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) || /^mailto:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (url.startsWith("cumulus-retry:")) { e.preventDefault(); return connect(); }
    if (isOurOrigin(url)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    lastLoadError = `${code} ${desc} ${url}`;
    if (isMainFrame && code !== -3 /* aborted */ && isOurOrigin(url)) showOffline();
  });
  // Unread count on the dock / taskbar badge.
  win.on("page-title-updated", (_e, title) => { try { app.setBadgeCount(unreadFromTitle(title)); } catch {} });

  connect();
}

async function connect() {
  clearTimeout(retryTimer);
  origin = await pickOrigin();
  try {
    await win.loadURL(`${origin}/?source=desktop`);
    if (process.env.CUMULUS_SMOKE) return smokeReport();
    if (pendingLink) { const l = pendingLink; pendingLink = null; handleLink(l); }
  } catch (e) {
    lastLoadError = lastLoadError || String(e);
    showOffline();
  }
}

/** CUMULUS_SMOKE=1: report what loaded (used by CI on every platform) and quit. */
async function smokeReport() {
  await new Promise((r) => setTimeout(r, 3000));
  const report = await win.webContents.executeJavaScript(
    `({ url: location.href, title: document.title, signIn: !!document.querySelector(".auth-card"), browserButton: [...document.querySelectorAll("button")].some((b) => b.textContent === "Sign in with your browser"), bridge: typeof window.cumulusDesktop?.signInWithBrowser })`,
  ).catch((e) => ({ error: String(e) }));
  const out = JSON.stringify({ origin, ...report });
  try { fs.writeFileSync(process.env.CUMULUS_SMOKE_OUT || path.join(app.getPath("temp"), "cumulus-mail-smoke.json"), out); } catch {}
  process.stdout.write(`SMOKE ${out}\n`);
  app.exit(report.url && report.url.startsWith(origin) ? 0 : 1);
}

function showOffline() {
  if (process.env.CUMULUS_SMOKE) {
    const out = JSON.stringify({ origin, offline: true, reason: lastLoadError });
    try { fs.writeFileSync(process.env.CUMULUS_SMOKE_OUT || path.join(app.getPath("temp"), "cumulus-mail-smoke.json"), out); } catch {}
    process.stdout.write(`SMOKE ${out}\n`);
    return app.exit(1);
  }
  if (!win || win.isDestroyed()) return;
  win.loadFile(path.join(__dirname, "offline.html")).catch(() => {});
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, 15_000);
}

/* ---------------- Links: browser sign-in and mailto ---------------- */

function handleLink(link) {
  const action = parseAppLink(link);
  if (!action) return;
  if (!win || win.isDestroyed() || !isOurOrigin(win.webContents.getURL())) { pendingLink = link; return; }
  if (action.type === "signin") return finishBrowserSignIn(action.code);
  if (action.type === "compose") {
    const q = new URLSearchParams({ compose: "1", to: action.to });
    if (action.subject) q.set("subject", action.subject);
    if (action.body) q.set("body", action.body);
    win.loadURL(`${origin}/?${q}`);
  }
  win.focus();
}

ipcMain.handle("cumulus:signin-browser", (event) => {
  if (!isOurOrigin(event.senderFrame?.url ?? "")) throw new Error("Not allowed");
  const verifier = randomBytes(32).toString("base64url");
  signin = { verifier, at: Date.now() };
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  shell.openExternal(`${PRIMARY}/?desktop=${challenge}`);
  return true;
});

async function finishBrowserSignIn(code) {
  if (!signin || Date.now() - signin.at > SIGNIN_TTL_MS) return; // only finish a sign-in this app started
  const { verifier } = signin;
  signin = null;
  const body = JSON.stringify({ code, verifier });
  const ok = await win.webContents.executeJavaScript(
    `fetch("/api/auth/desktop/redeem", { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1" }, credentials: "same-origin", body: ${JSON.stringify(body)} }).then((r) => r.ok).catch(() => false)`,
  );
  await win.loadURL(`${origin}/?source=desktop`);
  if (!ok) win.webContents.executeJavaScript(`alert("Signing in didn't finish. Please try again.")`).catch(() => {});
  win.focus();
}

/* ---------------- Menu ---------------- */

function buildMenu() {
  const isMac = process.platform === "darwin";
  const compose = () => win && win.loadURL(`${origin}/?compose=1`);
  const go = (path) => () => win && win.loadURL(`${origin}${path}`);
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      { label: "New Message", accelerator: "CmdOrCtrl+N", click: compose },
      { label: "New Document", click: go("/drive/#/new/dox") },
      { label: "New Spreadsheet", click: go("/drive/#/new/spreads") },
      { label: "New Presentation", click: go("/drive/#/new/podium") },
      { type: "separator" },
      { label: "Open in Browser", click: () => shell.openExternal(`${origin}/`) },
      { type: "separator" },
      isMac ? { role: "close" } : { role: "quit" },
    ] },
    { role: "editMenu" },
    { label: "Go", submenu: [
      { label: "Mail", accelerator: "CmdOrCtrl+1", click: go("/") },
      { label: "Drive", accelerator: "CmdOrCtrl+2", click: go("/drive/") },
      { label: "Shared with me", click: go("/drive/#/shared") },
      { label: "Recent", click: go("/drive/#/recent") },
    ] },
    { label: "View", submenu: [
      { role: "reload" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
    { role: "help", submenu: [
      { label: "Cumulus://Mail™ Help", click: () => shell.openExternal("https://cumuluscloud.app/") },
      { label: `Version ${app.getVersion()}`, enabled: false },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- Start ---------------- */

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(`${ses.getUserAgent()} CumulusMailDesktop/${app.getVersion()}`);
  // Mail needs notifications and the clipboard (copy). Nothing else: no camera, mic, location.
  const allowed = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);
  ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed.has(permission) && isOurOrigin(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed.has(permission) && isOurOrigin(requestingOrigin));
  buildMenu();
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else win?.show(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
});
