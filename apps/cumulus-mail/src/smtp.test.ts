import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import PostalMime from "postal-mime";
import type { OutboundSend } from "@infinitum/mail";
import { MemoryFileStore } from "./files.ts";
import { buildMessage, dotStuff, encodeWord, isLoopback, smtpConfigFromEnv, smtpSender } from "./smtp.ts";

/** A scripted SMTP relay. `answer` can override the reply to any command. */
function fakeRelay(opts: { ehlo?: string[]; answer?: (cmd: string) => string | undefined } = {}) {
  const commands: string[] = [];
  const messages: string[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buf = "";
    let data: string | null = null;
    const say = (s: string) => socket.write(s + "\r\n");
    say("220 relay.test ESMTP");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buf.slice(0, end + 2));
          buf = buf.slice(end + 5);
          data = null;
          say(opts.answer?.("END-DATA") ?? "250 2.0.0 Ok: queued as ABC");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        commands.push(line);
        const custom = opts.answer?.(line);
        if (custom) { say(custom); continue; }
        const verb = line.split(/[ :]/)[0]!.toUpperCase();
        if (verb === "EHLO") say(["250-relay.test", ...(opts.ehlo ?? ["AUTH PLAIN LOGIN"]).map((e) => `250-${e}`), "250 8BITMIME"].join("\r\n"));
        else if (verb === "AUTH") say("235 2.7.0 Authentication successful");
        else if (verb === "DATA") { data = ""; say("354 End data with <CR><LF>.<CR><LF>"); }
        else if (verb === "QUIT") { say("221 Bye"); socket.end(); }
        else say("250 OK");
      }
    });
    socket.on("error", () => {});
  });
  const ready = new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
  return { commands, messages, ready, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const job = (over: Partial<OutboundSend> = {}): OutboundSend => ({
  id: "job-1",
  from: { email: "alex@cumuluscloud.app", name: "Алекс" },
  to: ["priya@example.com"],
  cc: ["sam@example.org"],
  subject: "Привет — plans",
  text: "Hi Priya,\n.leading dot line\nSee https://cumuluscloud.app.\n",
  attachments: [],
  ...over,
});

const relays: ReturnType<typeof fakeRelay>[] = [];
const relay = (opts?: Parameters<typeof fakeRelay>[0]) => {
  const r = fakeRelay(opts);
  relays.push(r);
  return r;
};
after(async () => { await Promise.all(relays.map((r) => r.close())); });

describe("SMTP submission (Node mode outbound)", () => {
  it("signs in, sends the envelope to every recipient, and the message parses back", async () => {
    const r = relay();
    const port = await r.ready;
    const result = await smtpSender({ host: "127.0.0.1", port, user: "relay-user", password: "s3cret" })(job());
    assert.equal(result.ok, true);
    assert.deepEqual(r.commands.map((c) => c.split(" ")[0]), ["EHLO", "AUTH", "MAIL", "RCPT", "RCPT", "DATA", "QUIT"]);
    assert.equal(r.commands[1], `AUTH PLAIN ${Buffer.from("\0relay-user\0s3cret").toString("base64")}`);
    assert.equal(r.commands[2], "MAIL FROM:<alex@cumuluscloud.app>");
    assert.deepEqual(r.commands.slice(3, 5), ["RCPT TO:<priya@example.com>", "RCPT TO:<sam@example.org>"]);

    const raw = r.messages[0]!.replace(/^\.\./gm, ".");
    const parsed = await PostalMime.parse(raw);
    assert.equal(parsed.subject, "Привет — plans");
    assert.equal(parsed.from?.name, "Алекс");
    assert.equal(parsed.text?.includes(".leading dot line"), true);
    assert.match(parsed.html ?? "", /<a href="https:\/\/cumuluscloud.app">/);
    assert.equal(parsed.messageId, (result as { providerId: string }).providerId);
  });

  it("uses AUTH LOGIN when that's all the relay offers, and no AUTH without credentials", async () => {
    const r = relay({ ehlo: ["AUTH LOGIN"], answer: (c) => (c === "AUTH LOGIN" || c === Buffer.from("u").toString("base64") ? "334 VXNlcm5hbWU6" : c === Buffer.from("p").toString("base64") ? "235 OK" : undefined) });
    const port = await r.ready;
    assert.equal((await smtpSender({ host: "127.0.0.1", port, user: "u", password: "p" })(job())).ok, true);
    assert.deepEqual(r.commands.slice(1, 4), ["AUTH LOGIN", Buffer.from("u").toString("base64"), Buffer.from("p").toString("base64")]);

    const anon = relay();
    const anonPort = await anon.ready;
    assert.equal((await smtpSender({ host: "127.0.0.1", port: anonPort })(job())).ok, true);
    assert.equal(anon.commands.some((c) => c.startsWith("AUTH")), false);
  });

  it("5xx about the message is permanent; bad credentials and 4xx are retried", async () => {
    const rejected = relay({ answer: (c) => (c.startsWith("RCPT TO:<priya") ? "550 5.1.1 No such user" : undefined) });
    const res = await smtpSender({ host: "127.0.0.1", port: await rejected.ready })(job());
    assert.equal(res.ok, false);
    assert.equal((res as { permanent: boolean }).permanent, true);
    assert.match((res as { error: string }).error, /No such user/);
    assert.equal(rejected.messages.length, 0, "nothing is sent when a recipient is refused");

    const badAuth = relay({ answer: (c) => (c.startsWith("AUTH") ? "535 5.7.8 Authentication failed" : undefined) });
    const auth = await smtpSender({ host: "127.0.0.1", port: await badAuth.ready, user: "u", password: "wrong" })(job());
    assert.deepEqual(auth, { ok: false, error: "Cumulus couldn't reach the outside mail service.", permanent: false });

    const busy = relay({ answer: (c) => (c === "END-DATA" ? "451 4.3.0 Try later" : undefined) });
    assert.equal((await smtpSender({ host: "127.0.0.1", port: await busy.ready })(job()) as { permanent: boolean }).permanent, false);

    assert.equal((await smtpSender({ host: "127.0.0.1", port: 1, timeoutMs: 2_000 })(job()) as { permanent: boolean }).permanent, false);
  });

  it("plain SMTP is only allowed to a relay on this machine", () => {
    for (const host of ["127.0.0.1", "127.0.0.53", "::1", "localhost"]) assert.equal(isLoopback(host), true, host);
    for (const host of ["smtp.relay.example", "10.0.0.5", "::ffff:8.8.8.8", "localhost.evil.example", "128.0.0.1"]) assert.equal(isLoopback(host), false, host);
  });

  it("attaches stored files; missing or oversized files fail without sending", async () => {
    const files = new MemoryFileStore();
    await files.put("in/f1", new TextEncoder().encode("hello file"), "text/plain");
    const r = relay();
    const port = await r.ready;
    const ok = await smtpSender({ host: "127.0.0.1", port }, files)(job({ attachments: [{ id: "in/f1", name: "отчёт.txt", type: "text/plain", size: 10 }] }));
    assert.equal(ok.ok, true);
    const parsed = await PostalMime.parse(r.messages[0]!);
    assert.equal(parsed.attachments[0]?.filename, "отчёт.txt");
    assert.equal(new TextDecoder().decode(parsed.attachments[0]!.content as ArrayBuffer), "hello file");

    const gone = await smtpSender({ host: "127.0.0.1", port }, files)(job({ attachments: [{ id: "in/none", name: "x.pdf", size: 1 }] }));
    assert.equal((gone as { permanent: boolean }).permanent, true);
    const big = await smtpSender({ host: "127.0.0.1", port }, files)(job({ attachments: [{ id: "in/f1", name: "x", size: 25 * 1024 * 1024 }] }));
    assert.equal((big as { permanent: boolean }).permanent, true);
    assert.equal(r.messages.length, 1);
  });
});

describe("MIME and configuration", () => {
  it("headers can't be injected and non-ASCII is encoded", () => {
    const { raw } = buildMessage(job({ subject: "Hi\r\nBcc: victim@example.com", from: { email: "alex@cumuluscloud.app", name: 'Al "x"\r\nX-Evil: 1' } }), []);
    const head = raw.split("\r\n\r\n")[0]!;
    assert.equal(/^Bcc:/m.test(head), false);
    assert.equal(/^X-Evil:/m.test(head), false);
    assert.match(encodeWord("Привет"), /^=\?UTF-8\?B\?/);
    assert.equal(encodeWord("plain"), "plain");
    assert.equal(dotStuff("a\r\n.b\r\n"), "a\r\n..b\r\n.\r\n");
  });

  it("reads MAIL_SMTP_* and needs user and password together", () => {
    assert.equal(smtpConfigFromEnv({}), null);
    assert.deepEqual(smtpConfigFromEnv({ MAIL_SMTP_HOST: "smtp.relay.example", MAIL_SMTP_USER: "u", MAIL_SMTP_PASSWORD: "p" }), { host: "smtp.relay.example", port: 587, user: "u", password: "p", secure: false, heloName: undefined });
    assert.equal(smtpConfigFromEnv({ MAIL_SMTP_HOST: "h", MAIL_SMTP_PORT: "465" })!.secure, true);
    assert.throws(() => smtpConfigFromEnv({ MAIL_SMTP_HOST: "h", MAIL_SMTP_USER: "u" }), /both/);
    assert.throws(() => smtpConfigFromEnv({ MAIL_SMTP_HOST: "h", MAIL_SMTP_PORT: "abc" }), /port/);
  });
});
