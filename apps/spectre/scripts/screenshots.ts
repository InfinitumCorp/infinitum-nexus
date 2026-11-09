/**
 * Renders +SPCTR with fictional sample data in headless Chrome and saves screenshots.
 *   node scripts/screenshots.ts <outDir>
 * Uses the Chrome DevTools Protocol directly (Node 22 has a built-in WebSocket).
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService } from "@infinitum/cid";
import { SpectreCRM } from "../src/core/crm.ts";
import { createApp } from "../src/server/app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, "../screenshots");
mkdirSync(outDir, { recursive: true });
const PORT = 4321;
const ORIGIN = `http://localhost:${PORT}`;
const DAY = 86_400_000;

const signer = generateSigner();
const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
// Placeholder credentials so every sign-in option is shown; no provider is contacted.
const display = { clientId: "screenshot", clientSecret: "screenshot" };
const cid = new CidService({
  ledger, signer, rpId: "localhost", origins: [ORIGIN],
  social: { providers: { google: display, apple: { clientId: "screenshot" }, microsoft: display, github: display, chatgpt: { ...display, issuer: "https://issuer.example" } } },
});
const crm = new SpectreCRM({ ledger, signer });
const app = createApp({ cid, crm, ai: {}, publicDir: join(here, "../public"), secureCookies: false, origin: "http://localhost" });

// Fictional sample workspace.
const me = await cid.createAccount({ username: "alex" });
await cid.grant(me.cid, "spectre", ["crm:read", "crm:write"]);
const { token } = await (cid as unknown as { issueSession(c: string, d: string, m: string): Promise<{ token: string }> }).issueSession(me.cid, "Screenshot", "passkey");
const ws = me.cid;
const now = Date.now();
const ago = (d: number) => new Date(now - d * DAY).toISOString();
const inDays = (d: number) => new Date(now + d * DAY).toISOString().slice(0, 10);

const nw = await crm.addCompany(ws, me.cid, { name: "Northwind Logistics", domain: "northwind.example", industry: "Logistics" });
const mt = await crm.addCompany(ws, me.cid, { name: "Ministry of Transport", domain: "transport.gov.example", kind: "agency" });
const ct = await crm.addCompany(ws, me.cid, { name: "Contoso Health", domain: "contoso.example", industry: "Healthcare" });
const fb = await crm.addCompany(ws, me.cid, { name: "Fabrikam Energy", domain: "fabrikam.example", industry: "Energy" });
await crm.addFact(ws, "agent:researcher", nw.id, { field: "funding", value: "Raised a Series B", source: "https://news.example/northwind" });

const dana = await crm.addContact(ws, me.cid, { name: "Dana Ruiz", title: "COO", companyId: nw.id, email: "dana@northwind.example", influence: "decision-maker" });
const omar = await crm.addContact(ws, me.cid, { name: "Omar Haddad", title: "Head of Fleet", companyId: nw.id, email: "omar@northwind.example", influence: "champion" });
const lin = await crm.addContact(ws, me.cid, { name: "Lin Chen", title: "Procurement Director", companyId: mt.id, influence: "decision-maker" });
const sara = await crm.addContact(ws, me.cid, { name: "Sara Novak", title: "CIO", companyId: ct.id, influence: "decision-maker" });
const ben = await crm.addContact(ws, me.cid, { name: "Ben Ito", title: "VP Operations", companyId: fb.id });

const d1 = await crm.addDeal(ws, me.cid, { companyId: nw.id, name: "Fleet tracking rollout", amount: 180000, closeDate: inDays(20), stage: "proposal", contactIds: [dana.id, omar.id] });
const d2 = await crm.addDeal(ws, me.cid, { companyId: mt.id, name: "Traffic analytics tender", amount: 420000, closeDate: inDays(-6), stage: "negotiation", market: "government", contactIds: [lin.id] });
await crm.addDeal(ws, me.cid, { companyId: ct.id, name: "Patient CRM pilot", amount: 65000, closeDate: inDays(45), stage: "discovery", contactIds: [sara.id] });
await crm.addDeal(ws, me.cid, { companyId: fb.id, name: "Field ops automation", amount: 95000, closeDate: inDays(70), stage: "qualified", contactIds: [ben.id] });
await crm.addDeal(ws, me.cid, { companyId: ct.id, name: "Data platform expansion", amount: 120000, closeDate: inDays(5), stage: "won", contactIds: [sara.id] });

await crm.logActivity(ws, me.cid, { kind: "meeting", summary: "Demo with fleet team", dealId: d1.id, contactIds: [omar.id], at: ago(6) });
await crm.logActivity(ws, me.cid, { kind: "email", summary: "Dana asked about rollout timeline", dealId: d1.id, contactIds: [dana.id], inbound: true, at: ago(2) });
await crm.logActivity(ws, me.cid, { kind: "email", summary: "Sent revised pricing", dealId: d2.id, contactIds: [lin.id], at: ago(33) });
await crm.relate(ws, me.cid, `cid:${me.cid}`, omar.id, 4);

const server = app.server().listen(PORT);

// Launch Chrome with remote debugging.
const profile = mkdtempSync(join(tmpdir(), "chrome-"));
const chrome = spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=9333", `--user-data-dir=${profile}`, "--window-size=1440,900", "about:blank"], { stdio: "ignore" });

async function waitFor<T>(fn: () => Promise<T>, tries = 50): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error("timed out");
}

const targets = await waitFor(async () => (await fetch("http://127.0.0.1:9333/json")).json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>);
const page = targets.find((t) => t.type === "page")!;
const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => sock.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
sock.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg.result ?? msg); pending.delete(msg.id); }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => { const id = ++seq; pending.set(id, resolve); sock.send(JSON.stringify({ id, method, params })); });

await send("Page.enable");
await send("Network.enable");

async function shot(name: string, path: string, opts: { width?: number; height?: number; mobile?: boolean } = {}) {
  await send("Emulation.setDeviceMetricsOverride", { width: opts.width ?? 1440, height: opts.height ?? 900, deviceScaleFactor: 1, mobile: opts.mobile ?? false });
  await send("Page.navigate", { url: "about:blank" });
  await new Promise((r) => setTimeout(r, 150));
  await send("Page.navigate", { url: `${ORIGIN}${path}` });
  await new Promise((r) => setTimeout(r, 1200));
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
  console.log("saved", name);
}

await shot("01-sign-in", "/");
const set = await send("Network.setCookie", { name: "spctr_session", value: token, url: ORIGIN, path: "/", httpOnly: true });
if (!set.success) throw new Error("could not set session cookie");
await shot("02-today", "/#/today");
await shot("03-pipeline", "/#/pipeline");
await shot("04-account", `/#/accounts/${nw.id}`);
await shot("05-people", "/#/people");
await shot("07-settings", "/#/settings");
await shot("08-agents", "/#/agents");
await shot("09-conjure", "/#/conjure");
await shot("06-today-mobile", "/#/today", { width: 390, height: 844, mobile: true });

sock.close();
chrome.kill();
server.close();
process.exit(0);
