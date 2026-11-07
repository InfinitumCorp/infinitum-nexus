import { veilLabyrinth } from "./lib/labyrinth.js";
/**
 * VEIL background service worker.
 * Owns the workspace, the Tor proxy, the browser proxy, New Identity and the $VEIL ledger.
 * Pages and the extension UI only send requests; all state changes happen here.
 * The browser proxy protects this browser's traffic only. It is not a device-wide VPN.
 */
import { emptyLedger, recordActivity, summarize, issueReceipt } from "./lib/rewards.js";
import {
  ANONYMOUS, DEFAULT_WORKSPACE, can, normalize, planSwitch, SITE_DATA_TYPES,
} from "./lib/workspace.js";
import { APPS, badgeText, launcher, parseSummary, resolveOrigins } from "./lib/nexus.js";
import { createBrowserProxy, detectPlatform } from "./lib/browser-proxy.js";
import { bypassHostsFor } from "./lib/proxy.js";
import { fetchSession, postConnect, postDisconnect, VeilApiError } from "./lib/veil-api.js";

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});

const TOR = Object.freeze({ scheme: "socks5", host: "127.0.0.1", port: 9050 });
const VEIL_ALARM = "veil-proxy";
const proxy = createBrowserProxy(detectPlatform());

// chrome.storage has no transactions; run every read-modify-write in order.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

const get = (keys) => chrome.storage.local.get(keys);
const set = (items) => chrome.storage.local.set(items);

async function getWorkspace() {
  const { workspace } = await get(["workspace"]);
  return normalize(workspace);
}

function veilView(session) {
  return { ...proxy.publicState, session: session ?? null };
}

// ---------- Tor ----------

async function setTor(enabled) {
  if (enabled && proxy.mode !== "off") throw new Error("Disconnect VEIL before turning Tor on");
  if (enabled) {
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        // SOCKS5 in Chrome resolves host names through the proxy, so DNS goes over Tor.
        rules: { singleProxy: { ...TOR }, bypassList: ["localhost", "127.0.0.1", "[::1]"] },
      },
      scope: "regular",
    });
    // Keep WebRTC from sending UDP outside the proxy (local IP leak).
    await chrome.privacy.network.webRTCIPHandlingPolicy
      .set({ value: "disable_non_proxied_udp" })
      .catch(() => {});
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
    await chrome.privacy.network.webRTCIPHandlingPolicy.clear({}).catch(() => {});
  }
  await set({ torEnabled: !!enabled });
  return !!enabled;
}

async function checkTor() {
  try {
    const r = await fetch("https://check.torproject.org/api/ip", { cache: "no-store", credentials: "omit" });
    const data = await r.json();
    return { isTor: !!data.IsTor };
  } catch (err) {
    return { isTor: false, error: String(err) };
  }
}

// ---------- Browser proxy ----------

let proxyAuthReady = false;

function registerProxyAuth() {
  const firefox = !!globalThis.browser?.proxy?.onRequest;
  const api = firefox ? globalThis.browser.webRequest : chrome.webRequest;
  if (!api?.onAuthRequired?.addListener) return;
  try {
    api.onAuthRequired.addListener((details, callback) => {
      const result = proxy.onAuthRequired(details);
      if (result.failClosed) serial(() => enterFailClosed());
      if (typeof callback === "function") {
        callback(result.response);
        return undefined;
      }
      return result.response;
    }, { urls: ["<all_urls>"] }, firefox ? ["blocking"] : ["asyncBlocking"]);
    proxyAuthReady = true;
  } catch {
    proxyAuthReady = false;
  }
}

if (globalThis.browser?.proxy?.onRequest?.addListener) {
  globalThis.browser.proxy.onRequest.addListener(
    (details) => proxy.onRequest(details.url),
    { urls: ["<all_urls>"] },
  );
}
registerProxyAuth();
chrome.proxy?.onProxyError?.addListener(() => {
  serial(async () => {
    if (proxy.onProxyError()) await enterFailClosed();
  });
});

async function enterFailClosed() {
  const o = await origins();
  await proxy.failClosed(bypassHostsFor(o));
  await set({ veilStatus: "fail-closed" });
  return veilView((await get(["veilSession"])).veilSession ?? null);
}

async function disconnectVeil() {
  const { veil: origin } = await origins();
  if (proxy.mode !== "off") await postDisconnect(origin).catch(() => {});
  await proxy.disconnect();
  await chrome.alarms?.clear(VEIL_ALARM).catch(() => {});
  await set({ veilStatus: "off" });
  return veilView((await get(["veilSession"])).veilSession ?? null);
}

async function connectVeil(serverId) {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  if (!proxyAuthReady) throw new Error("Proxy authentication is unavailable in this browser");
  const stored = await get(["torEnabled"]);
  if (stored.torEnabled) throw new Error("Turn off Tor before connecting VEIL");
  const o = await origins();
  const grant = await postConnect(o.veil, serverId);
  await proxy.connect(grant.server, grant.auth, bypassHostsFor(o));
  const minutes = Math.max(1, Math.ceil((Date.parse(grant.auth.expiresAt) - Date.now() - 30_000) / 60_000));
  await chrome.alarms?.create(VEIL_ALARM, { delayInMinutes: minutes }).catch(() => {});
  await set({ veilStatus: "connected", veilServerId: grant.server.id });
  const view = veilView((await get(["veilSession"])).veilSession ?? null);
  if (JSON.stringify(view).includes(grant.auth.password)) throw new Error("Refused to retain the proxy password");
  return view;
}

async function refreshVeil() {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  const o = await origins();
  try {
    const session = await fetchSession(o.veil);
    await set({ veilSession: session });
    if (!session.entitled && proxy.mode !== "off") await enterFailClosed();
    return { session, veil: veilView(session) };
  } catch (err) {
    if (proxy.mode !== "off" && (err instanceof VeilApiError) && (err.status === 401 || err.status === 403)) {
      await enterFailClosed();
    }
    throw err;
  }
}

async function restoreVeil() {
  const { veilStatus, veilServerId } = await get(["veilStatus", "veilServerId"]);
  if (veilStatus !== "connected" && veilStatus !== "fail-closed") return;
  await enterFailClosed();
  if (!veilServerId) return;
  try {
    await connectVeil(veilServerId);
  } catch {
    await enterFailClosed();
  }
}

// ---------- Site data ----------

async function clearSiteData() {
  await chrome.browsingData.remove({ since: 0 }, SITE_DATA_TYPES);
}

/**
 * New Identity: clear site data and close every tab, like Tor Browser.
 * A new Tor circuit needs the Tor control port, which an extension cannot
 * reach; restart the local Tor service for a fresh circuit.
 */
async function newIdentity() {
  await clearSiteData();
  await signOutLocally(); // the CID session cookie is gone too
  const tabs = await chrome.tabs.query({});
  const fresh = await chrome.tabs.create({ url: "about:blank" });
  await chrome.tabs.remove(tabs.map((t) => t.id).filter((id) => id !== fresh.id));
  return { ok: true };
}

// ---------- Workspaces ----------

async function switchWorkspace(to, confirmed) {
  const from = await getWorkspace();
  const plan = planSwitch(from, to);
  if (!plan) return { workspace: from, changed: false };
  if (!confirmed) return { workspace: from, changed: false, plan };
  if (plan.clearSiteData) await clearSiteData();
  await set({ workspace: plan.to });
  if (plan.to === ANONYMOUS) await signOutLocally(); // nothing from the account stays behind
  return { workspace: plan.to, changed: true };
}

// ---------- Cumulus://ID and the Nexus ----------

const ACCOUNT_ALARM = "veil-account";
const ACCOUNT_REFRESH_MINUTES = 5;

async function origins() {
  const { origins: stored } = await get(["origins"]);
  return resolveOrigins(stored);
}

async function setBadge(unread) {
  await chrome.action.setBadgeText({ text: badgeText(unread) }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: "#4ade80" }).catch(() => {});
}

async function signOutLocally() {
  if (proxy.mode !== "off") await disconnectVeil();
  await set({ cidUser: null, account: null, veilSession: null });
  await chrome.alarms.clear(ACCOUNT_ALARM).catch(() => {});
  await setBadge(0);
}

/**
 * Read the signed-in CID and its Cumulus summary (mail, storage, wallet)
 * from the CID origin's session. Signed-in workspace only.
 */
async function refreshAccount() {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  const { cid } = await origins();
  const r = await fetch(`${cid}/api/me`, { credentials: "include", cache: "no-store" });
  if (r.status === 401 || r.status === 403) {
    await signOutLocally();
    return { cidUser: null, account: null };
  }
  if (!r.ok) throw new Error(`CID origin answered ${r.status}`);
  const account = parseSummary(await r.json());
  if (!account) throw new Error("CID origin sent an account without a CID");
  const cidUser = { cid: account.cid, username: account.username, mailAddress: account.mailAddress };
  await set({ cidUser, account });
  await setBadge(account.mail?.unread ?? 0);
  await chrome.alarms.create(ACCOUNT_ALARM, { periodInMinutes: ACCOUNT_REFRESH_MINUTES });
  return { cidUser, account };
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === VEIL_ALARM) {
    serial(async () => {
      const { veilServerId, veilStatus } = await get(["veilServerId", "veilStatus"]);
      if (veilStatus !== "connected" || !veilServerId) return;
      try {
        await connectVeil(veilServerId);
      } catch {
        await enterFailClosed();
      }
    });
    return;
  }
  if (alarm.name !== ACCOUNT_ALARM) return;
  serial(async () => {
    if (!can(await getWorkspace(), "signin")) return signOutLocally();
    await refreshAccount().catch(() => {}); // offline: keep the last summary
    if (proxy.mode === "off") return;
    try {
      const session = await fetchSession((await origins()).veil);
      await set({ veilSession: session });
      if (!session.entitled) await enterFailClosed();
    } catch (err) {
      if ((err instanceof VeilApiError) && (err.status === 401 || err.status === 403)) await enterFailClosed();
    }
  });
});

/** Open a Nexus product in a new tab. Only registered apps and http(s) origins. */
async function openApp(id) {
  if (!can(await getWorkspace(), "signin")) throw new Error("Apps are off in the anonymous workspace");
  if (!APPS.some((a) => a.id === id)) throw new Error(`Unknown app: ${id}`);
  const { account } = await get(["account"]);
  const entry = launcher(await origins(), account).find((a) => a.id === id);
  if (!entry?.url) throw new Error(`${entry?.name ?? id} has no client yet`);
  await chrome.tabs.create({ url: entry.url });
  return { opened: entry.url };
}

// ---------- Rewards ----------

async function loadLedger() {
  const { rewardsLedger } = await get(["rewardsLedger"]);
  return rewardsLedger ?? emptyLedger();
}

async function onActivity(msg, sender) {
  if (!can(await getWorkspace(), "rewards")) return { credited: false, reason: "workspace" };
  // Only the tab the person is looking at can earn.
  const tab = sender.tab;
  if (!tab || !tab.active) return { credited: false, reason: "inactive-tab" };
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) return { credited: false, reason: "unfocused-window" };

  const ledger = await loadLedger();
  const result = recordActivity(ledger, {
    at: Date.now(), // our clock, not the page's
    trusted: msg.trusted === true,
    visible: msg.visible === true,
    focused: msg.focused === true,
  });
  if (result.ledger !== ledger) await set({ rewardsLedger: result.ledger });
  return { credited: result.credited, reason: result.reason };
}

async function rewardsSummary() {
  const ledger = await loadLedger();
  return { summary: summarize(ledger, Date.now()), receipts: ledger.receipts.slice(-5) };
}

async function claimRewards() {
  const workspace = await getWorkspace();
  if (!can(workspace, "rewards")) throw new Error("Rewards are off in the anonymous workspace");
  const { cidUser } = await get(["cidUser"]);
  const { ledger, receipt } = issueReceipt(await loadLedger(), cidUser?.cid, Date.now());
  await set({ rewardsLedger: ledger });
  return { receipt };
}

// ---------- Lifecycle & messages ----------

async function bootVeil() {
  const { veilStatus } = await get(["veilStatus"]);
  if (veilStatus === "connected" || veilStatus === "fail-closed") await restoreVeil();
  else proxy.readyOff();
}

chrome.runtime.onInstalled.addListener(async () => {
  // Fill only missing keys; updates must never wipe a ledger.
  const s = await get(["workspace", "torEnabled", "autoClean", "rewardsLedger", "veilStatus"]);
  const defaults = {};
  if (s.workspace === undefined) defaults.workspace = DEFAULT_WORKSPACE;
  if (s.torEnabled === undefined) defaults.torEnabled = false;
  if (s.autoClean === undefined) defaults.autoClean = true;
  if (s.rewardsLedger === undefined) defaults.rewardsLedger = emptyLedger();
  if (s.veilStatus === undefined) defaults.veilStatus = "off";
  await set(defaults);
  // v0.3 kept a float total that was not tied to the published policy.
  await chrome.storage.local.remove(["totalVeil", "rewardLog", "firmBalance"]);
});

chrome.runtime.onStartup?.addListener(() => {
  serial(() => bootVeil());
});

serial(() => bootVeil());

const handlers = {
  labyrinth: async (m) => veilLabyrinth((await origins()).cid, await getWorkspace(), m.command),
  getState: async () => {
    const s = await get(["torEnabled", "autoClean", "cidUser", "account", "veilSession", "veilStatus"]);
    const workspace = await getWorkspace();
    const signedIn = can(workspace, "signin");
    const o = await origins();
    return {
      workspace,
      torEnabled: !!s.torEnabled,
      autoClean: !!s.autoClean,
      cidUser: signedIn ? s.cidUser ?? null : null,
      account: signedIn ? s.account ?? null : null,
      apps: signedIn ? launcher(o, s.account) : [],
      origins: o,
      veil: signedIn ? veilView(s.veilSession ?? null) : { ...veilView(null), session: null, mode: proxy.mode },
    };
  },
  refreshAccount: () => refreshAccount(),
  refreshVeil: () => refreshVeil(),
  connectVeil: (m) => connectVeil(m.serverId).then((veil) => ({ veil })),
  disconnectVeil: () => disconnectVeil().then((veil) => ({ veil })),
  openApp: (m) => openApp(m.id),
  toggleTor: (m) => setTor(m.enabled).then((enabled) => ({ enabled })),
  checkTor: () => checkTor(),
  setAutoClean: (m) => set({ autoClean: !!m.enabled }).then(() => ({ ok: true })),
  newIdentity: () => newIdentity(),
  switchWorkspace: (m) => switchWorkspace(m.to, m.confirmed === true),
  activity: (m, sender) => onActivity(m, sender),
  getRewards: () => rewardsSummary(),
  claimRewards: () => claimRewards(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only VEIL's own pages and content scripts can reach this listener.
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `unknown message: ${msg?.type}` });
    return false;
  }
  // Content scripts (sender.url is the web page) may only report activity.
  // Everything else must come from one of VEIL's own extension pages.
  const fromExtensionPage = sender.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(chrome.runtime.getURL(""));
  const allowed = msg.type === "activity" ? !fromExtensionPage && !!sender.tab : fromExtensionPage;
  if (!allowed) {
    sendResponse({ error: "not allowed from a page" });
    return false;
  }
  serial(() => handler(msg, sender))
    .then((r) => sendResponse(r))
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});
