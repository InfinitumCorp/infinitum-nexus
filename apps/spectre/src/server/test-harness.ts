import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import type { CumulusConfig } from "@infinitum/cumulus";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";
import type { GrowthEvent } from "./growth-routes.ts";
import type { Providers } from "../core/messaging.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";

/** Shared harness for the growth-feature HTTP tests. */
export async function harness(opts: { providers?: Providers; cronSecret?: string; twilioAuthToken?: string; labyrinth?: CumulusConfig["labyrinth"]; labyrinthEndpoint?: string | null; labyrinthDirectoryKeySha256?: string | null; cidExportKeySha256?: string | null } = {}) {
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const suite = createCumulus({ ledger, signer, rpId: "localhost", origins: [ORIGIN], labyrinth: opts.labyrinth });
  const cid = suite.cid;
  let now = new Date("2026-11-05T09:00:00Z");
  const crm = new SpectreCRM({ ledger, signer, clock: () => now });
  const events: { ws: string; event: GrowthEvent }[] = [];
  let emitImpl = async (ws: string, event: GrowthEvent) => { events.push({ ws, event }); };
  const app = createApp({
    cid, suite, crm, ai: {}, publicDir: join(here, "../../public"), secureCookies: false, origin: ORIGIN,
    labyrinthEndpoint: null, labyrinthDirectoryKeySha256: null, cidExportKeySha256: null,
    emit: (ws, e) => emitImpl(ws, e),
    ...opts,
  });
  const server: Server = app.server();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, cookie?: string, headers: Record<string, string> = { "x-spectre": "1" }) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  const signUp = async (username: string) => {
    const auth = new VirtualAuthenticator();
    const s = await call("POST", "/api/auth/signup", { username });
    const f = await call("POST", "/api/auth/signup/finish", { cid: s.body.cid, response: auth.create({ challenge: s.body.options.challenge, origin: ORIGIN, rpId: "localhost" }) });
    const res = await fetch(base + "/api/auth/signin/finish", {
      method: "POST", headers: { "content-type": "application/json", "x-spectre": "1" },
      body: JSON.stringify({ response: auth.get({ credentialId: [...auth.credentials.keys()][0], challenge: f.body.options.challenge, origin: ORIGIN }) }),
    });
    return { cookie: res.headers.get("set-cookie")!.split(";")[0], cid: s.body.cid as string };
  };
  return {
    crm, ledger, suite, events, call, signUp, base, app,
    setEmit: (fn: typeof emitImpl) => { emitImpl = fn; },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    now: () => now,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

