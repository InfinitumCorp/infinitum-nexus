import { veilLabyrinth } from "./lib/labyrinth.js";
/**
 * VEIL background service worker.
 * Routes this browser through a local Tor SOCKS client. Pages and the
 * extension UI only send requests; proxy changes happen here.
 * This is not Tor Browser and it is not a device-wide VPN.
 */
import { emptyLedger, recordActivity, summarize, issueReceipt } from "./lib/rewards.js";
import {
  ANONYMOUS, DEFAULT_WORKSPACE, can, normalize, planSwitch, SITE_DATA_TYPES,
} from "./lib/workspace.js";
import { APPS, badgeText, launcher, parseSummary, resolveOrigins } from "./lib/nexus.js";
import { createRouteProxy, detectPlatform } from "./lib/browser-proxy.js";
import { bypassHostsFor, CHECK_URL, normalizeTorEndpoint, parseTorCheck } from "./lib/proxy.js";
import { fetchBridges, fetchSession, postConnect, postDisconnect, VeilApiError } from "./lib/veil-api.js";

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch?.(() => {});

const route = createRouteProxy(detectPlatform());

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

function routeView(session, bridges) {
  const state = route.publicState;
  return {
    ...state,
    session: session ?? null,
    bridges: bridges ?? null,
    tor: {
      ...state,
      status: state.mode === "tor" ? state.status : "off",
      endpoint: state.endpoint,
      mode: state.mode === "tor" ? "on" : "off",
    },
  };
}

// ---------- Tor ----------

async function rememberRoute() {
  await set({
    routeMode: route.mode === "veil" || route.mode === "tor" ? route.mode : "off",
    torEnabled: route.mode === "tor",
    torPort: route.publicState.endpoint.port,
    torStatus: route.mode === "tor" ? route.status : "off",
    veilServerId: route.publicState.server?.id ?? null,
  });
}

async function stopVeilServer() {
  if (route.mode !== "veil") return;
  const { veil: origin } = await origins();
  await postDisconnect(origin).catch(() => {});
}

async function connectVeil(serverId) {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  if (route.mode === "tor") await route.disable();
  const o = await origins();
  const grant = await postConnect(o.veil, serverId);
  await route.enableVeil(grant.server, grant.auth, bypassHostsFor(o));
  await rememberRoute();
  const view = routeView((await get(["veilSession"])).veilSession ?? null, null);
  if (JSON.stringify(view).includes(grant.auth.password)) throw new Error("Refused to retain the proxy password");
  return { veil: view, route: view };
}

async function routeOff() {
  await stopVeilServer();
  await route.disable();
  await rememberRoute();
  return { route: route.publicState };
}

async function setTor(enabled, port) {
  if (!enabled) {
    if (route.mode === "tor") await route.disable();
    await rememberRoute();
    return { enabled: false, tor: route.publicState };
  }
  await stopVeilServer();
  if (route.mode === "veil") await route.disable();
  const stored = port === undefined ? (await get(["torPort"])).torPort : port;
  const endpoint = normalizeTorEndpoint({ port: stored });
  await route.enable(endpoint);
  await rememberRoute();
  return { enabled: true, tor: route.publicState };
}

async function newCircuit() {
  const generation = route.rotate();
  if (route.mode === "tor") await route.reapply();
  return { generation, tor: route.publicState };
}

async function checkTor() {
  if (route.mode !== "tor") return { isTor: false, status: "off", tor: route.publicState };
  route.setStatus("checking");
  try {
    const response = await fetch(CHECK_URL, { cache: "no-store", credentials: "omit", redirect: "error" });
    const parsed = parseTorCheck(await response.json());
    route.setStatus(parsed.isTor ? "tor" : "not-tor");
    await rememberRoute();
    return { ...parsed, status: route.status, tor: route.publicState };
  } catch (err) {
    route.markUnreachable();
    await rememberRoute();
    return { isTor: false, status: "unreachable", error: String(err?.message ?? err), tor: route.publicState };
  }
}

function registerProxyAuth() {
  const firefox = !!globalThis.browser?.proxy?.onRequest;
  const api = firefox ? globalThis.browser.webRequest : chrome.webRequest;
  if (!api?.onAuthRequired?.addListener) return;
  try {
    api.onAuthRequired.addListener((details, callback) => {
      const result = route.onAuthRequired(details);
      if (typeof callback === "function") callback(result.response);
      return result.response;
    }, { urls: ["<all_urls>"] }, firefox ? ["blocking"] : ["asyncBlocking"]);
  } catch {
    /* The browser refused the auth listener. Firefox still isolates via onRequest. */
  }
}

if (globalThis.browser?.proxy?.onRequest?.addListener) {
  globalThis.browser.proxy.onRequest.addListener(
    (details) => route.onRequest(details),
    { urls: ["<all_urls>"] },
  );
}
registerProxyAuth();
chrome.proxy?.onProxyError?.addListener(() => {
  serial(async () => {
    if (!route.onProxyError()) return;
    route.markUnreachable();
    await rememberRoute();
  });
});

async function bootRoute() {
  const { routeMode, torEnabled, torPort, veilServerId } = await get(["routeMode", "torEnabled", "torPort", "veilServerId"]);
  if (routeMode === "tor" || torEnabled) {
    try {
      await route.enable(normalizeTorEndpoint({ port: torPort }));
      await rememberRoute();
    } catch {
      await route.failClosed();
      await rememberRoute();
    }
    return;
  }
  if (routeMode === "veil" && veilServerId) {
    try {
      await connectVeil(veilServerId);
    } catch {
      await route.failClosed();
      await rememberRoute();
    }
    return;
  }
  route.readyOff();
}

// ---------- Site data ----------

async function clearSiteData() {
  await chrome.browsingData.remove({ since: 0 }, SITE_DATA_TYPES);
}

async function clearAccount() {
  await set({ cidUser: null, account: null, veilSession: null, veilBridges: null });
  await chrome.alarms.clear(ACCOUNT_ALARM).catch(() => {});
  await setBadge(0);
}

/**
 * New Identity clears site data, closes tabs, and rotates the SOCKS
 * isolation password so the next circuits are new when Tor has
 * IsolateSOCKSAuth. Tor stays on. History, passwords and downloads stay.
 */
async function newIdentity() {
  const circuit = await newCircuit();
  await clearSiteData();
  await clearAccount();
  const tabs = await chrome.tabs.query({});
  const fresh = await chrome.tabs.create({ url: "about:blank" });
  await chrome.tabs.remove(tabs.map((t) => t.id).filter((id) => id !== fresh.id));
  return { ok: true, generation: circuit.generation };
}

// ---------- Workspaces ----------

async function switchWorkspace(to, confirmed) {
  const from = await getWorkspace();
  const plan = planSwitch(from, to);
  if (!plan) return { workspace: from, changed: false };
  if (!confirmed) return { workspace: from, changed: false, plan };
  if (plan.clearSiteData) await clearSiteData();
  await set({ workspace: plan.to });
  if (plan.to === ANONYMOUS) await clearAccount();
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

async function refreshAccount() {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  const { cid } = await origins();
  const response = await fetch(`${cid}/api/me`, { credentials: "include", cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    await clearAccount();
    return { cidUser: null, account: null };
  }
  if (!response.ok) throw new Error(`CID origin answered ${response.status}`);
  const account = parseSummary(await response.json());
  if (!account) throw new Error("CID origin sent an account without a CID");
  const cidUser = { cid: account.cid, username: account.username, mailAddress: account.mailAddress };
  await set({ cidUser, account });
  await setBadge(account.mail?.unread ?? 0);
  await chrome.alarms.create(ACCOUNT_ALARM, { periodInMinutes: ACCOUNT_REFRESH_MINUTES });
  return { cidUser, account };
}

/** Premium bridge lines. Failure here does not change Tor routing. */
async function refreshVeil() {
  if (!can(await getWorkspace(), "signin")) throw new Error("Sign-in is off in the anonymous workspace");
  const { veil: origin } = await origins();
  try {
    const session = await fetchSession(origin);
    let bridges = null;
    if (session.entitled) bridges = await fetchBridges(origin).catch(() => null);
    await set({ veilSession: session, veilBridges: bridges });
    if (route.mode === "veil" && !session.entitled) await route.failClosed();
    return { session, bridges, route: routeView(session, bridges) };
  } catch (err) {
    if (err instanceof VeilApiError && (err.status === 401 || err.status === 403)) {
      await set({ veilBridges: null });
    }
    throw err;
  }
}

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== ACCOUNT_ALARM) return;
  serial(async () => {
    if (!can(await getWorkspace(), "signin")) return clearAccount();
    await refreshAccount().catch(() => {});
  });
});

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
  const tab = sender.tab;
  if (!tab || !tab.active) return { credited: false, reason: "inactive-tab" };
  const win = await chrome.windows.get(tab.windowId).catch(() => null);
  if (!win?.focused) return { credited: false, reason: "unfocused-window" };
  const ledger = await loadLedger();
  const result = recordActivity(ledger, {
    at: Date.now(),
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
  const s = await get(["workspace", "torEnabled", "torPort", "autoClean", "rewardsLedger"]);
  const defaults = {};
  if (s.workspace === undefined) defaults.workspace = DEFAULT_WORKSPACE;
  if (s.torEnabled === undefined) defaults.torEnabled = false;
  if (s.torPort === undefined) defaults.torPort = 9050;
  if (s.autoClean === undefined) defaults.autoClean = true;
  if (s.rewardsLedger === undefined) defaults.rewardsLedger = emptyLedger();
  await set(defaults);
  await chrome.storage.local.remove(["totalVeil", "rewardLog", "firmBalance", "veilStatus", "veilServerId"]);
});

chrome.runtime.onStartup?.addListener(() => {
  serial(() => bootRoute());
});

serial(() => bootRoute());

const handlers = {
  labyrinth: async (m) => veilLabyrinth((await origins()).cid, await getWorkspace(), m.command),
  getState: async () => {
    const s = await get(["torEnabled", "autoClean", "cidUser", "account", "veilSession", "veilBridges"]);
    const workspace = await getWorkspace();
    const signedIn = can(workspace, "signin");
    const o = await origins();
    return {
      workspace,
      torEnabled: route.mode === "tor",
      autoClean: !!s.autoClean,
      cidUser: signedIn ? s.cidUser ?? null : null,
      account: signedIn ? s.account ?? null : null,
      apps: signedIn ? launcher(o, s.account) : [],
      origins: o,
      route: routeView(signedIn ? s.veilSession ?? null : null, signedIn ? s.veilBridges ?? null : null),
      tor: routeView(signedIn ? s.veilSession ?? null : null, signedIn ? s.veilBridges ?? null : null).tor,
    };
  },
  refreshAccount: () => refreshAccount(),
  refreshVeil: () => refreshVeil(),
  connectVeil: (m) => connectVeil(m.serverId),
  disconnectVeil: () => routeOff(),
  openApp: (m) => openApp(m.id),
  toggleTor: (m) => setTor(m.enabled === true, m.port),
  checkTor: () => checkTor(),
  newCircuit: () => newCircuit(),
  setAutoClean: (m) => set({ autoClean: !!m.enabled }).then(() => ({ ok: true })),
  newIdentity: () => newIdentity(),
  switchWorkspace: (m) => switchWorkspace(m.to, m.confirmed === true),
  activity: (m, sender) => onActivity(m, sender),
  getRewards: () => rewardsSummary(),
  claimRewards: () => claimRewards(),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) {
    sendResponse({ error: `unknown message: ${msg?.type}` });
    return false;
  }
  const fromExtensionPage = sender.id === chrome.runtime.id
    && typeof sender.url === "string"
    && sender.url.startsWith(chrome.runtime.getURL(""));
  const allowed = msg.type === "activity" ? !fromExtensionPage && !!sender.tab : fromExtensionPage;
  if (!allowed) {
    sendResponse({ error: "not allowed from a page" });
    return false;
  }
  serial(() => handler(msg, sender))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});
