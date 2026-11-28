import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PostOffice, PostOfficeStore } from "@infinitum/mail";
import { inboundConfigFromEnv, inboundHandler, startOutboundLoop } from "./node-mail.ts";
import { EX_NOUSER, EX_OK, EX_TEMPFAIL, EX_UNAVAILABLE, deliverToMail, exitCodeFor, parseArgs } from "./postfix-pipe.ts";
import { MemoryFileStore } from "./files.ts";

const ID = "mx.ru.cumuluscloud.app";
const TOKEN = "test-inbound-token-0123456789";

/** A message as Postfix hands it to the pipe: its own Received, the milters' headers, then the sender's hop. */
const message = (opts: { dmarc?: string; forged?: boolean; subject?: string; attach?: boolean } = {}) => {
  const lines = [
    `Received: from mail.bank.example by ${ID} (Postfix) with ESMTPS id 4Xy`,
    ...(opts.forged ? [] : [`Authentication-Results: ${ID}; dmarc=${opts.dmarc ?? "pass"} header.from=bank.example`, `Authentication-Results: ${ID}; spf=pass smtp.mailfrom=bank.example`]),
    "Received: from app by mail.bank.example",
    ...(opts.forged ? [`Authentication-Results: ${ID}; dmarc=pass header.from=bank.example`] : []),
    "From: Bank <news@bank.example>",
    "To: Alex <alex@cumuluscloud.app>",
    `Subject: ${opts.subject ?? "Statement"}`,
    "Date: Sat, 28 Nov 2026 10:00:00 +0000",
    "MIME-Version: 1.0",
  ];
  if (!opts.attach) return [...lines, "Content-Type: text/plain; charset=utf-8", "", "Your statement is ready.", ""].join("\r\n");
  return [
    ...lines,
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--b",
    "Content-Type: application/pdf",
    'Content-Disposition: attachment; filename="s.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-1.4 test").toString("base64"),
    "--b--",
    "",
  ].join("\r\n");
};

describe("Node-mode inbound (Postfix -> Mail)", () => {
  let server: Server;
  let url = "";
  const po = new PostOffice({ store: new PostOfficeStore() });
  const files = new MemoryFileStore();
  let saves = 0;

  before(async () => {
    await po.provision({ cid: "cid_a", address: "alex@cumuluscloud.app", name: "alex" });
    const handle = inboundHandler({
      token: TOKEN,
      authservId: ID,
      files,
      receive: async (mail) => {
        const r = await po.receive(mail);
        saves++;
        return r;
      },
    });
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/inbound`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  const pipe = (raw: string, sender = "bounce@bank.example", recipient = "alex@cumuluscloud.app", token = TOKEN) =>
    deliverToMail({ url, token, sender, recipient }, new Uint8Array(Buffer.from(raw)));
  const inbox = async () => (await po.view("cid_a")).messages;

  it("delivers, keeping our MTA's SPF/DMARC verdict, and saves", async () => {
    assert.deepEqual(await pipe(message()), { code: EX_OK, message: "HTTP 200" });
    const got = (await inbox()).find((m) => m.subject === "Statement")!;
    assert.equal(got.from.email, "bounce@bank.example");
    assert.equal(got.auth?.verified, true);
    assert.equal(got.auth?.dmarc, "pass");
    assert.equal(got.auth?.spf, "pass");
    assert.equal(saves, 1);
  });

  it("bounces dmarc=fail for good, and never trusts a header the sender wrote", async () => {
    const failed = await pipe(message({ dmarc: "fail", subject: "Verify" }));
    assert.equal(failed.code, EX_UNAVAILABLE);
    assert.match(failed.message, /DMARC/);
    assert.equal((await inbox()).filter((m) => m.subject === "Verify").length, 0);

    assert.equal((await pipe(message({ forged: true, subject: "Forged" }))).code, EX_OK);
    assert.deepEqual((await inbox()).find((m) => m.subject === "Forged")!.auth, { verified: false });
  });

  it("unknown mailbox bounces as no-such-user; spoofed Cumulus sender bounces", async () => {
    assert.equal((await pipe(message(), "a@bank.example", "nobody@cumuluscloud.app")).code, EX_NOUSER);
    assert.equal((await pipe(message(), "ceo@cumuluscloud.app")).code, EX_UNAVAILABLE);
  });

  it("a null sender (a bounce) shows the header From", async () => {
    assert.equal((await pipe(message({ subject: "Undelivered" }), "")).code, EX_OK);
    assert.equal((await inbox()).find((m) => m.subject === "Undelivered")!.from.email, "news@bank.example");
  });

  it("stores attachments so the recipient can open them", async () => {
    assert.equal((await pipe(message({ attach: true, subject: "With file" }))).code, EX_OK);
    const got = (await inbox()).find((m) => m.subject === "With file")!;
    const file = got.attachments?.[0];
    assert.equal(file?.name, "s.pdf");
    assert.equal(Buffer.from((await files.get(file!.id!))!.data).toString(), "%PDF-1.4 test");
  });

  it("refuses a wrong token and requests that aren't deliveries", async () => {
    const before = saves;
    assert.equal((await pipe(message(), undefined, undefined, "wrong-token-wrong-token")).code, EX_TEMPFAIL);
    assert.equal((await fetch(url.replace("/inbound", "/other"), { method: "POST" })).status, 404);
    assert.equal((await fetch(`${url}?sender=a@b.example`, { method: "POST", headers: { "x-cumulus-inbound-token": TOKEN } })).status, 400);
    assert.equal(saves, before);
  });

  it("Mail being down or a store error keeps the message queued", async () => {
    assert.equal((await deliverToMail({ url: "http://127.0.0.1:1/inbound", token: TOKEN, sender: "a@b.example", recipient: "x@cumuluscloud.app" }, new Uint8Array(1))).code, EX_TEMPFAIL);
    const broken = inboundHandler({ token: TOKEN, authservId: ID, receive: async () => { throw new Error("disk full"); } });
    const s = createServer((req, res) => void broken(req, res));
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const r = await deliverToMail({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/inbound`, token: TOKEN, sender: "a@bank.example", recipient: "alex@cumuluscloud.app" }, new Uint8Array(Buffer.from(message())));
    await new Promise<void>((done) => s.close(() => done()));
    assert.equal(r.code, EX_TEMPFAIL);
  });
});

describe("Node-mode configuration", () => {
  it("inbound is off without a port and needs a token and authserv-id with one", () => {
    assert.equal(inboundConfigFromEnv({}), null);
    assert.throws(() => inboundConfigFromEnv({ MAIL_INBOUND_PORT: "3011", MAIL_INBOUND_AUTHSERV_ID: ID }), /TOKEN/);
    assert.throws(() => inboundConfigFromEnv({ MAIL_INBOUND_PORT: "3011", MAIL_INBOUND_TOKEN: TOKEN }), /AUTHSERV_ID/);
    assert.throws(() => inboundConfigFromEnv({ MAIL_INBOUND_PORT: "x", MAIL_INBOUND_TOKEN: TOKEN, MAIL_INBOUND_AUTHSERV_ID: ID }), /port/);
    assert.deepEqual(inboundConfigFromEnv({ MAIL_INBOUND_PORT: "3011", MAIL_INBOUND_TOKEN: TOKEN, MAIL_INBOUND_AUTHSERV_ID: "MX.RU.cumuluscloud.app" }), { port: 3011, token: TOKEN, authservId: ID });
  });

  it("pipe arguments and exit codes", () => {
    assert.deepEqual(parseArgs(["--url", "http://127.0.0.1:9/inbound", "--", "a@b.example", "x@cumuluscloud.app"], { MAIL_INBOUND_TOKEN: TOKEN }), { url: "http://127.0.0.1:9/inbound", token: TOKEN, sender: "a@b.example", recipient: "x@cumuluscloud.app" });
    assert.equal(parseArgs(["--", "", "x@cumuluscloud.app"], { MAIL_INBOUND_TOKEN: TOKEN }).sender, "");
    assert.throws(() => parseArgs(["--", "a@b.example"], { MAIL_INBOUND_TOKEN: TOKEN }), /usage/);
    assert.throws(() => parseArgs(["--", "a@b.example", "x@cumuluscloud.app"], {}), /token/);
    assert.deepEqual([200, 404, 422, 413, 401, 400, 500, 503].map(exitCodeFor), [0, 67, 69, 69, 75, 75, 75, 75]);
  });
});

describe("Node-mode outbound loop", () => {
  it("runs at once, never overlaps, and survives a failed run", async () => {
    let runs = 0;
    let active = 0;
    let overlap = false;
    const stop = startOutboundLoop(async () => {
      runs++;
      active++;
      if (active > 1) overlap = true;
      await new Promise((r) => setTimeout(r, 40));
      active--;
      if (runs === 1) throw new Error("relay down");
      return 1;
    }, 10);
    await new Promise((r) => setTimeout(r, 150));
    stop();
    assert.ok(runs >= 2, `ran ${runs} times`);
    assert.equal(overlap, false);
  });
});
