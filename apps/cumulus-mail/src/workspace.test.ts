import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";
import { MemoryFileStore } from "./files.ts";
import { WorkspaceStore, validDoc } from "./workspace.ts";
import { idClientFor } from "./id-provider.ts";

let base = "";
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;
let suite: ReturnType<typeof createCumulus>;
const files = new MemoryFileStore();
const store = new WorkspaceStore();

before(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  const signer = generateSigner();
  suite = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: [base], mailOrigin: base });
  server = createMailApp({ suite, files, workspaceStore: store, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

const call = async (method: string, path: string, cookie = "", body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-cumulus": "1", cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const set = res.headers.get("set-cookie");
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: data, cookie: set ? set.split(";")[0]! : "", headers: res.headers };
};

async function signUp(username: string) {
  const auth = new VirtualAuthenticator();
  const a = await call("POST", "/api/auth/signup", "", { username });
  const b = await call("POST", "/api/auth/signup/finish", "", { cid: a.body.cid, response: auth.create({ challenge: a.body.options.challenge, origin: base, rpId: "localhost" }) });
  const c = await call("POST", "/api/auth/signin/finish", "", { response: auth.get({ credentialId: b.body.options.allowCredentials[0].id, challenge: b.body.options.challenge, origin: base }) });
  return c.cookie;
}

describe("Cumulus://Drive", () => {
  it("folders, uploads, downloads, rename, move, star, trash and delete", async () => {
    const me = await signUp("driver");
    const folder = await call("POST", "/api/drive/folders", me, { name: "Plans" });
    assert.equal(folder.status, 200, JSON.stringify(folder.body));
    const up = await fetch(`${base}/api/drive/upload?name=${encodeURIComponent("notes.txt")}&parent=${folder.body.id}`, {
      method: "POST", headers: { "x-cumulus": "1", cookie: me, "content-type": "text/plain" }, body: "hello drive",
    });
    assert.equal(up.status, 200);
    const file = (await up.json()) as any;
    assert.equal(file.size, 11);

    const inside = await call("GET", `/api/drive?folder=${folder.body.id}`, me);
    assert.deepEqual(inside.body.items.map((i: any) => i.name), ["notes.txt"]);
    assert.deepEqual(inside.body.path.map((p: any) => p.name), ["Plans"]);
    assert.equal(inside.body.usage.byProduct.cloud, 11);

    const dl = await fetch(`${base}/api/drive/items/${file.id}/download`, { headers: { cookie: me } });
    assert.equal(await dl.text(), "hello drive");
    assert.match(dl.headers.get("content-disposition")!, /attachment/);
    assert.match(dl.headers.get("content-security-policy")!, /sandbox/);

    await call("PATCH", `/api/drive/items/${file.id}`, me, { name: "renamed.txt", parent: null, starred: true });
    const root = await call("GET", "/api/drive", me);
    assert.deepEqual(root.body.items.map((i: any) => i.name), ["Plans", "renamed.txt"]);
    assert.equal((await call("GET", "/api/drive?view=starred", me)).body.items.length, 1);

    // A folder can't go inside itself.
    const sub = await call("POST", "/api/drive/folders", me, { name: "Sub", parent: folder.body.id });
    assert.equal((await call("PATCH", `/api/drive/items/${folder.body.id}`, me, { parent: sub.body.id })).status, 400);

    assert.equal((await call("DELETE", `/api/drive/items/${file.id}`, me)).status, 400); // trash first
    await call("PATCH", `/api/drive/items/${file.id}`, me, { trashed: true });
    assert.equal((await call("GET", "/api/drive?view=trash", me)).body.items.length, 1);
    assert.equal((await call("POST", "/api/drive/trash/empty", me)).body.removed, 1);
    assert.equal((await call("GET", "/api/drive", me)).body.usage.byProduct.cloud, 0);
    assert.equal(files.files.has(`d/${file.id}`), false);
  });

  it("needs a session and the request header, and keeps people out of each other's files", async () => {
    assert.equal((await call("GET", "/api/drive")).status, 401);
    const a = await signUp("drivea");
    const b = await signUp("driveb");
    assert.equal((await call("POST", "/api/drive/folders", a, { name: "x" }, { "x-cumulus": "" })).status, 403);
    const doc = await call("POST", "/api/drive/docs", a, { kind: "dox", name: "Secret" });
    assert.equal((await call("GET", `/api/drive/items/${doc.body.id}/doc`, b)).status, 404);
    assert.equal((await fetch(`${base}/api/drive/items/${doc.body.id}/download`, { headers: { cookie: b } })).status, 404);
  });

  it("revoking Drive in CID permissions sticks", async () => {
    const me = await signUp("driverev");
    assert.equal((await call("GET", "/api/drive", me)).status, 200);
    const cidValue = suite.stores.cid.byUsername.get("driverev")!;
    await suite.cid.revoke(cidValue, "cumulus-cloud");
    assert.equal((await call("GET", "/api/drive", me)).status, 403);
  });
});

describe("Cumulus://Dox, Spreads and Podium", () => {
  it("create, open, save with version checks, and share with mail notice", async () => {
    const owner = await signUp("docowner");
    const friend = await signUp("docfriend");
    for (const kind of ["dox", "spreads", "podium"]) {
      const made = await call("POST", "/api/drive/docs", owner, { kind });
      assert.equal(made.status, 200, JSON.stringify(made.body));
      const opened = await call("GET", `/api/drive/items/${made.body.id}/doc`, owner);
      assert.ok(validDoc(kind as any, opened.body.doc), kind);
    }
    const sheet = await call("POST", "/api/drive/docs", owner, { kind: "spreads", name: "Budget" });
    const doc = { sheets: [{ name: "Sheet1", cells: { A1: "10", A2: "20", A3: "=SUM(A1:A2)" } }] };
    const saved = await call("PUT", `/api/drive/items/${sheet.body.id}/doc`, owner, { doc, version: 1 });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.version, 2);
    // Saving on top of an old version is refused.
    assert.equal((await call("PUT", `/api/drive/items/${sheet.body.id}/doc`, owner, { doc, version: 1 })).status, 409);
    // Bad contents are refused.
    assert.equal((await call("PUT", `/api/drive/items/${sheet.body.id}/doc`, owner, { doc: { sheets: [{ name: "x", cells: { "a;1": 1 } }] }, version: 2 })).status, 400);

    const shared = await call("POST", `/api/drive/items/${sheet.body.id}/share`, owner, { with: "docfriend@cumuluscloud.app" });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    assert.deepEqual(shared.body.sharedWith, ["docfriend@cumuluscloud.app"]);
    const theirs = await call("GET", "/api/drive?view=shared", friend);
    assert.deepEqual(theirs.body.items.map((i: any) => i.name), ["Budget"]);
    const read = await call("GET", `/api/drive/items/${sheet.body.id}/doc`, friend);
    assert.equal(read.body.doc.sheets[0].cells.A3, "=SUM(A1:A2)");
    // Editors can edit contents, not rename or delete.
    assert.equal((await call("PUT", `/api/drive/items/${sheet.body.id}/doc`, friend, { doc, version: 2 })).status, 200);
    assert.equal((await call("PATCH", `/api/drive/items/${sheet.body.id}`, friend, { name: "Mine" })).status, 404);
    const inbox = (await call("GET", "/api/state", friend)).body;
    assert.ok(inbox.messages.some((m: any) => /shared “Budget” with you/.test(m.subject)));
    assert.equal((await call("POST", `/api/drive/items/${sheet.body.id}/share`, owner, { with: "nobody-here" })).status, 404);
  });
});

describe("Sign in with Cumulus://ID", () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  };

  it("only sends codes to Infinitum product origins", () => {
    assert.ok(idClientFor("scalvs", "https://scalvs.app/account"));
    assert.equal(idClientFor("scalvs", "https://evil.example/"), null);
    assert.equal(idClientFor("scalvs", "https://scalvs.app.evil.example/"), null);
    assert.equal(idClientFor("nope", "https://scalvs.app/"), null);
    assert.equal(idClientFor("toString", "https://scalvs.app/"), null);
  });

  it("signed out: goes to sign-in first; signed in: returns a code the product trades for a profile", async () => {
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ client_id: "scalvs", redirect_uri: "https://scalvs.app/signed-in", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
    const out = await call("GET", `/api/id/authorize?${q}`);
    assert.equal(out.status, 302);
    assert.match(out.headers.get("location")!, /^\/\?next=%2Fapi%2Fid%2Fauthorize/);

    const me = await signUp("idperson");
    const back = await call("GET", `/api/id/authorize?${q}`, me);
    assert.equal(back.status, 302);
    const to = new URL(back.headers.get("location")!);
    assert.equal(to.origin + to.pathname, "https://scalvs.app/signed-in");
    assert.equal(to.searchParams.get("state"), "xyz");

    // The product's page posts text/plain JSON (no preflight).
    const token = await call("POST", "/api/id/token", "", { code: to.searchParams.get("code"), code_verifier: verifier, client_id: "scalvs" }, { "content-type": "text/plain", "x-cumulus": "", origin: "https://scalvs.app" });
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.equal(token.body.profile.email, "idperson@cumuluscloud.app");
    assert.equal(token.headers.get("access-control-allow-origin"), "https://scalvs.app");
    const who = await call("GET", "/api/id/userinfo", "", undefined, { authorization: `Bearer ${token.body.access_token}` });
    assert.equal(who.body.username, "idperson");
    assert.ok(suite.cid.can(suite.stores.cid.byUsername.get("idperson")!, "scalvs", "profile:read"));
    await call("POST", "/api/id/signout", "", {}, { authorization: `Bearer ${token.body.access_token}`, "x-cumulus": "" });
    assert.equal((await call("GET", "/api/id/userinfo", "", undefined, { authorization: `Bearer ${token.body.access_token}` })).status, 401);
  });

  it("refuses foreign redirects, missing PKCE, and codes used by another product", async () => {
    const me = await signUp("idperson2");
    const { verifier, challenge } = pkce();
    const bad = new URLSearchParams({ client_id: "scalvs", redirect_uri: "https://evil.example/", code_challenge: challenge });
    assert.equal((await call("GET", `/api/id/authorize?${bad}`, me)).status, 400);
    const noPkce = new URLSearchParams({ client_id: "scalvs", redirect_uri: "https://scalvs.app/" });
    assert.equal((await call("GET", `/api/id/authorize?${noPkce}`, me)).status, 400);
    const q = new URLSearchParams({ client_id: "scalvs", redirect_uri: "https://scalvs.app/", code_challenge: challenge });
    const code = new URL((await call("GET", `/api/id/authorize?${q}`, me)).headers.get("location")!).searchParams.get("code");
    assert.equal((await call("POST", "/api/id/token", "", { code, code_verifier: verifier, client_id: "metatron" })).status, 400);
  });

  it("redirect-only flow for sites that allow no cross-origin requests", async () => {
    const me = await signUp("idperson3");
    const { verifier, challenge } = pkce();
    const page = "https://mttrn.app/";
    const q = new URLSearchParams({ client_id: "metatron", redirect_uri: page, code_challenge: challenge, state: "s1" });
    const code = new URL((await call("GET", `/api/id/authorize?${q}`, me)).headers.get("location")!).searchParams.get("code")!;

    // A wrong verifier comes back as an error in the fragment, never as a token.
    const wrong = await call("GET", `/api/id/redeem?${new URLSearchParams({ client_id: "metatron", redirect_uri: page, code, code_verifier: "x".repeat(43), state: "s1" })}`);
    assert.equal(wrong.status, 302);
    const wrongTo = new URL(wrong.headers.get("location")!);
    assert.ok(new URLSearchParams(wrongTo.hash.slice(1)).get("cid_error"));
    assert.equal(new URLSearchParams(wrongTo.hash.slice(1)).get("cid_token"), null);

    // Codes work once, so start again for the good path.
    const code2 = new URL((await call("GET", `/api/id/authorize?${q}`, me)).headers.get("location")!).searchParams.get("code")!;
    const ok = await call("GET", `/api/id/redeem?${new URLSearchParams({ client_id: "metatron", redirect_uri: page, code: code2, code_verifier: verifier, state: "s1" })}`);
    const to = new URL(ok.headers.get("location")!);
    assert.equal(to.origin + to.pathname, page);
    assert.equal(to.search, "");
    const frag = new URLSearchParams(to.hash.slice(1));
    assert.equal(frag.get("state"), "s1");
    assert.equal(JSON.parse(Buffer.from(frag.get("profile")!, "base64url").toString()).email, "idperson3@cumuluscloud.app");
    const token = frag.get("cid_token")!;
    assert.equal((await call("GET", "/api/id/userinfo", "", undefined, { authorization: `Bearer ${token}` })).status, 200);

    // Redirects only go to the product's own origin.
    assert.equal((await call("GET", `/api/id/redeem?${new URLSearchParams({ client_id: "metatron", redirect_uri: "https://evil.example/", code: code2, code_verifier: verifier })}`)).status, 400);
    assert.equal((await call("GET", `/api/id/end?${new URLSearchParams({ client_id: "metatron", redirect_uri: "https://evil.example/", token })}`)).status, 400);

    // Sign out ends that session and returns to the page.
    const end = await call("GET", `/api/id/end?${new URLSearchParams({ client_id: "metatron", redirect_uri: page, token })}`);
    assert.equal(end.headers.get("location"), page);
    assert.equal((await call("GET", "/api/id/userinfo", "", undefined, { authorization: `Bearer ${token}` })).status, 401);
  });
});
