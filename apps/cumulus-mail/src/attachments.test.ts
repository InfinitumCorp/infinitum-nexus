import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";
import { MemoryFileStore } from "./files.ts";
import { storeInboundFiles, toInbound } from "./inbound.ts";

let base = "";
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;
let suite: ReturnType<typeof createCumulus>;
const store = new MemoryFileStore();

before(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  const signer = generateSigner();
  suite = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: [base], mailOrigin: base });
  // Like hosted mode: every request runs inside a transaction, and the app must not touch state outside one.
  let inTx = false;
  const transaction = async <T>(fn: () => Promise<T>) => { inTx = true; try { return await fn(); } finally { inTx = false; } };
  const authenticate = suite.cid.authenticate.bind(suite.cid);
  suite.cid.authenticate = ((token: string) => { if (!inTx) throw new Error("session checked outside a transaction"); return authenticate(token); }) as typeof suite.cid.authenticate;
  server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false, files: store, transaction }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

async function signUp(username: string) {
  const auth = new VirtualAuthenticator();
  let cookie = "";
  const call = async (path: string, body: unknown) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: JSON.stringify(body) });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return (await res.json()) as any;
  };
  const a = await call("/api/auth/signup", { username });
  const b = await call("/api/auth/signup/finish", { cid: a.cid, response: auth.create({ challenge: a.options.challenge, origin: base, rpId: "localhost" }) });
  await call("/api/auth/signin/finish", { response: auth.get({ credentialId: b.options.allowCredentials[0].id, challenge: b.options.challenge, origin: base }) });
  return { cookie, cid: a.cid as string, address: `${username}@cumuluscloud.app` };
}

const upload = (cookie: string, name: string, body: Uint8Array | string, type = "application/pdf", headers: Record<string, string> = { "x-cumulus": "1" }) =>
  fetch(`${base}/api/files?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type, cookie, ...headers }, body: body as BodyInit });
const download = (cookie: string, id: string) => fetch(`${base}/api/files/${id}`, { headers: { cookie } });
const send = (cookie: string, body: unknown) =>
  fetch(`${base}/api/send`, { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1", cookie }, body: JSON.stringify(body) });

describe("Attachments", () => {
  it("upload, send to a Cumulus user, and the recipient downloads the same bytes", async () => {
    const alex = await signUp("alexfiles");
    const sam = await signUp("samfiles");
    const res = await upload(alex.cookie, "Plan Q4.pdf", "%PDF-1.7 hello");
    assert.equal(res.status, 200);
    const file = (await res.json()) as any;
    assert.match(file.id, new RegExp(`^u/${alex.cid}/[0-9a-f-]{36}$`));
    assert.deepEqual({ name: file.name, size: file.size, type: file.type }, { name: "Plan Q4.pdf", size: 14, type: "application/pdf" });

    const sent = await send(alex.cookie, { to: sam.address, subject: "Plan", body: "Attached.", attachments: [file] });
    assert.equal(sent.status, 200);
    const got = await download(sam.cookie, file.id);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "%PDF-1.7 hello");
    assert.match(got.headers.get("content-disposition")!, /^attachment; filename="Plan Q4.pdf"/);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  });

  it("someone the file wasn't sent to can't download it", async () => {
    const owner = await signUp("ownerfiles");
    const stranger = await signUp("strangerfiles");
    const file = (await (await upload(owner.cookie, "secret.txt", "s3cret", "text/plain")).json()) as any;
    assert.equal((await download(owner.cookie, file.id)).status, 200);
    assert.equal((await download(stranger.cookie, file.id)).status, 404);
    assert.equal((await fetch(`${base}/api/files/${file.id}`)).status, 401);
  });

  it("you can't attach someone else's file by its id", async () => {
    const owner = await signUp("owner2files");
    const thief = await signUp("thieffiles");
    const file = (await (await upload(owner.cookie, "a.txt", "x", "text/plain")).json()) as any;
    const res = await send(thief.cookie, { to: thief.address, subject: "Mine now", body: ".", attachments: [file] });
    assert.equal(res.status, 403);
  });

  it("uploads need the app's header and stay under 25 MB", async () => {
    const u = await signUp("limitfiles");
    assert.equal((await upload(u.cookie, "x.bin", "x", "application/octet-stream", {})).status, 403);
    assert.equal((await upload(u.cookie, "big.bin", new Uint8Array(25 * 1024 * 1024 + 1))).status, 413);
  });

  it("files on outside mail are stored and open for the recipient", async () => {
    const pat = await signUp("patfiles");
    const parsed = { from: { address: "priya@example.com" }, subject: "Photos", text: "Here", attachments: [{ filename: "beach.jpg", mimeType: "image/jpeg", content: new TextEncoder().encode("JPEGDATA").buffer }] };
    const inbound = await storeInboundFiles(toInbound("priya@example.com", pat.address, parsed), parsed, store);
    await suite.mail.receive(inbound);
    const att = inbound.attachments![0]!;
    assert.match(att.id!, /^in\/[0-9a-f-]{36}$/);
    const got = await download(pat.cookie, att.id!);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "JPEGDATA");
  });
});
