import { veilLabyrinth } from "./lib/labyrinth.js";
/**
 * VEIL background service worker.
 * Owns the workspace, the Tor proxy, New Identity and the $VEIL ledger.
 * Pages and the sidebar only send requests; all state changes happen here.
 */
import { emptyLedger, recordActivity, summarize, issueReceipt } from "./lib/rewards.js";
import {
  ANONYMOUS, DEFAULT_WORKSPACE, can, normalize, planSwitch, SITE_DATA_TYPES,
} from "./lib/workspace.js";
import { APPS, badgeText, launcher, parseSummary, resolveOrigins } from "./lib/nexus.js";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const TOR = Object.freeze({ scheme: "socks5", host: "127.0.0.1", port: 9050 });

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

// ---------- Tor ----------

async function setTor(enabled) {
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
  const { origins } = await get(["origins"]);
  return resolveOrigins(origins);
}

async function setBadge(unread) {
  await chrome.action.setBadgeText({ text: badgeText(unread) }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: "#4ade80" }).catch(() => {});
}

async function signOutLocally() {
  await set({ cidUser: null, account: null });
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
  if (alarm.name !== ACCOUNT_ALARM) return;
  serial(async () => {
    if (!can(await getWorkspace(), "signin")) return signOutLocally();
    await refreshAccount().catch(() => {}); // offline: keep the last summary
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

chrome.runtime.onInstalled.addListener(async () => {
  // Fill only missing keys; updates must never wipe a ledger.
  const s = await get(["workspace", "torEnabled", "autoClean", "rewardsLedger"]);
  const defaults = {};
  if (s.workspace === undefined) defaults.workspace = DEFAULT_WORKSPACE;
  if (s.torEnabled === undefined) defaults.torEnabled = false;
  if (s.autoClean === undefined) defaults.autoClean = true;
  if (s.rewardsLedger === undefined) defaults.rewardsLedger = emptyLedger();
  await set(defaults);
  // v0.3 kept a float total that was not tied to the published policy.
  await chrome.storage.local.remove(["totalVeil", "rewardLog", "firmBalance"]);
});

const handlers = {
  labyrinth: async (m) => veilLabyrinth((await origins()).cid, await getWorkspace(), m.command),
  getState: async () => {
    const s = await get(["torEnabled", "autoClean", "cidUser", "account"]);
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
    };
  },
  refreshAccount: () => refreshAccount(),
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
