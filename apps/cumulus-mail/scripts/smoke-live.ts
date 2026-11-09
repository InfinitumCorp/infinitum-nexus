/**
 * Smoke test for a deployed Cumulus://Mail: signs up a test account with a virtual passkey, signs
 * in, checks the welcome mail, sends a message to itself and reads it back.
 *
 *   node --experimental-strip-types apps/cumulus-mail/scripts/smoke-live.ts https://cumulus-mail.vercel.app [username]
 *
 * It creates a real account on that deployment, so give it an obvious test name.
 * Prints the session cookie to SMOKE_COOKIE_FILE when set (for checking the signed-in app on a phone).
 */
import { writeFileSync } from "node:fs";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base)) throw new Error("Pass the deployment's https URL (or a local http URL)");
const username = process.argv[3] ?? `smoketest${Date.now().toString(36)}`;
const rpId = new URL(base).hostname;
const auth = new VirtualAuthenticator();
let cookie = "";

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-cumulus": "1", origin: base, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0]!;
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${typeof data === "string" ? data.slice(0, 200) : JSON.stringify(data)}`);
  return data;
}

const t0 = Date.now();
const a = await call("POST", "/api/auth/signup", { username });
const reg = auth.create({ challenge: a.options.challenge, origin: base, rpId });
const b = await call("POST", "/api/auth/signup/finish", { cid: a.cid, response: reg });
const credentialId = b.options.allowCredentials[0].id;
await call("POST", "/api/auth/signin/finish", { response: auth.get({ credentialId, challenge: b.options.challenge, origin: base }) });
console.log(`signed up and signed in as ${username} (${a.cid})`);

const state = await call("GET", "/api/state");
console.log(`mailbox ${state.me.email}: ${state.messages.length} messages, unread ${state.unread}`);
const sent = await call("POST", "/api/send", { to: state.me.email, subject: "Smoke test", body: `Deployed check at ${new Date().toISOString()}` });
console.log(`sent: delivered ${sent.delivered}, bounced ${JSON.stringify(sent.bounced)}`);
const after = await call("GET", "/api/state");
const got = after.messages.find((m: any) => m.folder === "inbox" && m.subject === "Smoke test");
if (!got) throw new Error("The message didn't arrive");
console.log(`received in inbox${got.tunnel ? " via the Cumulus Tunnel" : ""}; total ${Date.now() - t0} ms`);
if (process.env.SMOKE_COOKIE_FILE) writeFileSync(process.env.SMOKE_COOKIE_FILE, cookie);
