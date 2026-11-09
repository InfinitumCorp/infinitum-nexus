/** Minimal in-memory chrome.* for exercising background.js under node:test. */
export function fakeChrome({ windowFocused = true } = {}) {
  const store = {};
  const listeners = { message: [], installed: [], changed: [] };
  const calls = { proxySet: [], proxyClear: 0, webrtc: [], browsingData: [], tabsRemoved: [], tabsCreated: [], badge: [], alarms: {} };
  let tabs = [{ id: 1, windowId: 1, active: true }, { id: 2, windowId: 1, active: false }];
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (items) => { Object.assign(store, structuredClone(items)); },
        remove: async (keys) => { for (const k of keys) delete store[k]; },
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    proxy: { settings: {
      set: async (v) => { calls.proxySet.push(v); },
      clear: async () => { calls.proxyClear++; },
    } },
    privacy: { network: { webRTCIPHandlingPolicy: {
      set: async (v) => { calls.webrtc.push(v.value); },
      clear: async () => { calls.webrtc.push("cleared"); },
    } } },
    browsingData: { remove: async (opts, types) => { calls.browsingData.push(types); } },
    tabs: {
      query: async () => tabs,
      create: async (opts) => { calls.tabsCreated.push(opts?.url); const t = { id: 99, windowId: 1, active: true }; tabs.push(t); return t; },
      remove: async (ids) => { calls.tabsRemoved.push(...ids); tabs = tabs.filter((t) => !ids.includes(t.id)); },
    },
    alarms: {
      create: async (name, info) => { calls.alarms[name] = info; },
      clear: async (name) => { delete calls.alarms[name]; return true; },
      onAlarm: { addListener: (fn) => listeners.alarm = fn },
    },
    action: {
      setBadgeText: async ({ text }) => { calls.badge.push(text); },
      setBadgeBackgroundColor: async () => {},
    },
    windows: { get: async () => ({ focused: windowFocused }) },
    runtime: {
      id: "veilid",
      getURL: (p) => `chrome-extension://veilid/${p}`,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
  };
  /** Deliver a message the way Chrome does and resolve with the response. */
  const send = (msg, sender = {}) => new Promise((resolve) => {
    const async = listeners.message[0](msg, sender, resolve);
    if (!async) return;
  });
  return { chrome, store, calls, listeners, send };
}
