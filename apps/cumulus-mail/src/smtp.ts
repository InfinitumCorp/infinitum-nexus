import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { OutboundSend } from "@infinitum/mail";
import type { FileStore } from "./files.ts";
import { loadAttachments, textToHtml, type OutboundFile, type Sender } from "./outbound.ts";

/**
 * Mail to outside addresses over SMTP submission, for Node mode (a self-hosted server, such as the
 * Russia copy on Yandex Cloud). Yandex Cloud blocks outbound port 25, so mail goes to a relay on
 * 587 (STARTTLS) or 465 (TLS from the first byte) that signs in with MAIL_SMTP_USER and
 * MAIL_SMTP_PASSWORD. Built on node:net and node:tls only: npm is often unreachable from the
 * servers this runs on.
 *
 * Credentials are only ever sent over TLS. Plain SMTP is allowed only to a relay on this machine
 * (127.0.0.1 / ::1 / localhost), such as a local Postfix that relays onward.
 */

export interface SmtpConfig {
  host: string;
  /** 587 (STARTTLS) by default. 465 means TLS from the start. */
  port?: number;
  user?: string;
  password?: string;
  /** TLS from the first byte. Defaults to true on port 465. */
  secure?: boolean;
  /** Name sent in EHLO. Defaults to this machine's host name. */
  heloName?: string;
  /** Per-reply timeout. Default 30 s. */
  timeoutMs?: number;
  /** Tests only: accept a relay's self-signed certificate. */
  rejectUnauthorized?: boolean;
}

/** SMTP settings from the environment, or null when MAIL_SMTP_HOST isn't set. */
export function smtpConfigFromEnv(env: Record<string, string | undefined> = process.env): SmtpConfig | null {
  const host = env.MAIL_SMTP_HOST?.trim();
  if (!host) return null;
  const port = env.MAIL_SMTP_PORT ? Number(env.MAIL_SMTP_PORT) : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`MAIL_SMTP_PORT must be a port number, not "${env.MAIL_SMTP_PORT}".`);
  const user = env.MAIL_SMTP_USER?.trim() || undefined;
  const password = env.MAIL_SMTP_PASSWORD || undefined;
  if (Boolean(user) !== Boolean(password)) throw new Error("Set both MAIL_SMTP_USER and MAIL_SMTP_PASSWORD, or neither.");
  const secureRaw = env.MAIL_SMTP_SECURE?.trim().toLowerCase();
  return {
    host,
    port,
    user,
    password,
    secure: secureRaw ? secureRaw === "true" || secureRaw === "1" : port === 465,
    heloName: env.MAIL_SMTP_HELO?.trim() || undefined,
  };
}

/** A relay on this machine, where plain SMTP never leaves the host. */
export const isLoopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/* ---------------------------------- MIME ---------------------------------- */

const CRLF = "\r\n";
/** No header injection: a value is one line. */
const oneLine = (s: string) => s.replace(/[\r\n\0]+/g, " ").trim();
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for non-ASCII header text, in chunks that keep lines short. */
export function encodeWord(text: string): string {
  const s = oneLine(text);
  if (ascii(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(`${CRLF} `);
}

function address(p: { email: string; name?: string }): string {
  const email = oneLine(p.email);
  const name = p.name ? oneLine(p.name) : "";
  if (!name || name === email) return `<${email}>`;
  if (!ascii(name)) return `${encodeWord(name)} <${email}>`;
  return `"${name.replace(/["\\]/g, "")}" <${email}>`;
}

const base64Lines = (data: Uint8Array | string) => (Buffer.from(data as Uint8Array).toString("base64").match(/.{1,76}/g) ?? []).join(CRLF);

/**
 * A file name as a quoted parameter. Non-ASCII names use one RFC 2047 word, as Gmail and Outlook
 * send them; it's what mail clients (and postal-mime) read most reliably.
 */
function fileParam(filename: string): string {
  const name = oneLine(filename).replace(/["\\]/g, "_") || "attachment";
  return ascii(name) ? `"${name}"` : `"=?UTF-8?B?${Buffer.from(name, "utf8").toString("base64")}?="`;
}

const safeMime = (t: string) => (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(t) ? t : "application/octet-stream");

/** The whole RFC 5322 message: text with an HTML alternative, and the files, if any. */
export function buildMessage(job: OutboundSend, files: OutboundFile[], opts: { date?: Date; messageId?: string } = {}): { raw: string; messageId: string } {
  const domain = job.from.email.split("@")[1]?.replace(/[^a-z0-9.-]/gi, "") || "localhost";
  const messageId = opts.messageId ?? `<${randomBytes(12).toString("hex")}.${oneLine(job.id).replace(/[^a-z0-9._-]/gi, "")}@${domain}>`;
  const boundary = (tag: string) => `=_cumulus_${tag}_${randomBytes(9).toString("hex")}`;
  const alt = boundary("alt");
  const headers = [
    `From: ${address(job.from)}`,
    `To: ${job.to.map((e) => address({ email: e })).join(", ")}`,
    ...(job.cc.length ? [`Cc: ${job.cc.map((e) => address({ email: e })).join(", ")}`] : []),
    `Subject: ${encodeWord(job.subject || "(no subject)")}`,
    `Date: ${(opts.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    `X-Cumulus-Job: ${oneLine(job.id)}`,
  ];
  const alternative = [
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(job.text),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(textToHtml(job.text)),
    `--${alt}--`,
  ].join(CRLF);
  let body: string[];
  if (!files.length) {
    body = [`Content-Type: multipart/alternative; boundary="${alt}"`, "", alternative];
  } else {
    const mixed = boundary("mixed");
    body = [
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      "",
      `--${mixed}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      alternative,
      ...files.flatMap((f) => [
        `--${mixed}`,
        `Content-Type: ${safeMime(f.type)}; name=${fileParam(f.filename)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename=${fileParam(f.filename)}`,
        "",
        base64Lines(f.content),
      ]),
      `--${mixed}--`,
    ];
  }
  return { raw: [...headers, ...body].join(CRLF) + CRLF, messageId };
}

/** DATA payload: dot-stuffed, ending in CRLF.CRLF. */
export const dotStuff = (raw: string) => raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, "..") + (raw.endsWith(CRLF) ? "" : CRLF) + "." + CRLF;

/* --------------------------------- Session -------------------------------- */

export class SmtpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
  /** 5xx: the same message will fail the same way. */
  get permanent() { return this.code >= 500 && this.code < 600; }
}

interface Reply { code: number; lines: string[] }

/** One SMTP conversation. Reads replies line by line from whichever socket is current. */
class Session {
  private socket: Socket | TLSSocket;
  private buffer = "";
  private waiting: ((r: Reply | Error) => void) | null = null;
  private pending: string[] = [];
  private failed: Error | null = null;
  private readonly timeoutMs: number;

  constructor(socket: Socket | TLSSocket, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        this.pending.push(this.buffer.slice(0, i).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.deliver();
    });
    const fail = (err: Error) => {
      this.failed ??= err;
      this.deliver();
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The mail relay closed the connection.")));
  }

  /** Hand a complete reply to the reader, if one is waiting. */
  private deliver() {
    if (!this.waiting) return;
    const end = this.pending.findIndex((l) => /^\d{3}(?: |$)/.test(l));
    if (end >= 0) {
      const lines = this.pending.splice(0, end + 1);
      const take = this.waiting;
      this.waiting = null;
      take({ code: Number(lines[end]!.slice(0, 3)), lines: lines.map((l) => l.slice(4)) });
    } else if (this.failed) {
      const take = this.waiting;
      this.waiting = null;
      take(this.failed);
    }
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error("The mail relay stopped answering."));
      }, this.timeoutMs);
      this.waiting = (r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      };
      this.deliver();
    });
  }

  /** Send a line (null: just read the greeting). `label` names it in errors instead of the line itself. */
  async command(line: string | null, expect: number[], label?: string): Promise<Reply> {
    if (line !== null) this.socket.write(line + CRLF);
    const reply = await this.read();
    if (!expect.includes(reply.code)) {
      const what = label ?? (line === null ? "greeting" : line.split(":")[0]!);
      throw new SmtpError(reply.code, `${what}: ${reply.code} ${reply.lines.join(" ")}`.slice(0, 500));
    }
    return reply;
  }

  /** Upgrade the connection in place after STARTTLS. */
  async startTls(servername: string, rejectUnauthorized: boolean): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const s = tlsConnect({ socket: plain as Socket, servername: isIP(servername) ? undefined : servername, rejectUnauthorized }, () => resolve(s));
      s.once("error", reject);
    });
    this.socket = secure;
    this.buffer = "";
    this.pending = [];
    this.attach(secure);
  }

  /** Say goodbye politely when the conversation went well, then drop the connection. */
  async close(polite: boolean) {
    if (polite) await this.command("QUIT", [221]).catch(() => {});
    this.socket.destroy();
  }
}

function open(config: SmtpConfig, port: number, secure: boolean): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Couldn't reach the mail relay in time."));
    }, config.timeoutMs ?? 30_000);
    const done = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    const socket: Socket | TLSSocket = secure
      ? tlsConnect({ host: config.host, port, servername: isIP(config.host) ? undefined : config.host, rejectUnauthorized: config.rejectUnauthorized ?? true }, done)
      : netConnect({ host: config.host, port }, done);
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const extensions = (reply: Reply) => new Set(reply.lines.slice(1).map((l) => l.split(" ")[0]!.toUpperCase()));
const authMechanisms = (reply: Reply) => new Set(reply.lines.flatMap((l) => (/^AUTH[ =]/i.test(l) ? l.slice(5).toUpperCase().split(/\s+/) : [])));

/**
 * Send one message: EHLO, STARTTLS when not already on TLS, AUTH when credentials are set,
 * then the envelope and the data. Throws SmtpError for a relay reply and Error for the network.
 */
export async function sendSmtp(config: SmtpConfig, envelope: { from: string; to: string[] }, raw: string): Promise<string> {
  const port = config.port ?? 587;
  const secure = config.secure ?? port === 465;
  const helo = (config.heloName ?? hostname()).replace(/[^a-z0-9.-]/gi, "") || "localhost";
  const rejectUnauthorized = config.rejectUnauthorized ?? true;
  const session = new Session(await open(config, port, secure), config.timeoutMs ?? 30_000);
  let ok = false;
  try {
    await session.command(null, [220]);
    let ehlo = await session.command(`EHLO ${helo}`, [250]);
    let tls = secure;
    if (!tls && extensions(ehlo).has("STARTTLS")) {
      await session.command("STARTTLS", [220]);
      await session.startTls(config.host, rejectUnauthorized);
      tls = true;
      ehlo = await session.command(`EHLO ${helo}`, [250]);
    }
    if (!tls && !isLoopback(config.host)) {
      throw new Error(`The mail relay ${config.host} doesn't offer TLS, so Cumulus won't send through it.`);
    }
    if (config.user && config.password) {
      const mechs = authMechanisms(ehlo);
      if (mechs.has("PLAIN") || !mechs.has("LOGIN")) {
        const token = Buffer.from(`\0${config.user}\0${config.password}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN");
      } else {
        await session.command("AUTH LOGIN", [334]);
        await session.command(Buffer.from(config.user, "utf8").toString("base64"), [334], "AUTH LOGIN user");
        await session.command(Buffer.from(config.password, "utf8").toString("base64"), [235], "AUTH LOGIN password");
      }
    }
    const from = oneLine(envelope.from);
    await session.command(`MAIL FROM:<${from}>${extensions(ehlo).has("SMTPUTF8") && !ascii(from) ? " SMTPUTF8" : ""}`, [250]);
    for (const rcpt of envelope.to) await session.command(`RCPT TO:<${oneLine(rcpt)}>`, [250, 251]);
    await session.command("DATA", [354]);
    const done = await session.command(dotStuff(raw).replace(/\r\n$/, ""), [250], "end of data");
    ok = true;
    return done.lines.join(" ");
  } finally {
    await session.close(ok);
  }
}

/** Relay replies that mean "our setup is wrong", not "this message is bad": retry, don't bounce. */
const OUR_PROBLEM = new Set([530, 534, 535, 538]);

/** A Sender (see outbound.ts) that delivers each queued job through the SMTP relay. */
export function smtpSender(config: SmtpConfig, files?: FileStore, send = sendSmtp): Sender {
  return async (job) => {
    const loaded = await loadAttachments(job, files);
    if (!loaded.ok) return loaded;
    const { raw, messageId } = buildMessage(job, loaded.files);
    try {
      await send(config, { from: job.from.email, to: [...job.to, ...job.cc] }, raw);
      return { ok: true, providerId: messageId };
    } catch (err) {
      if (err instanceof SmtpError && err.permanent && !OUR_PROBLEM.has(err.code)) {
        return { ok: false, error: `The mail server refused the message (${err.message.replace(/^[A-Za-z ]+: /, "")}).`.slice(0, 300), permanent: true };
      }
      console.error("SMTP relay failed:", (err as Error).message);
      return { ok: false, error: "Cumulus couldn't reach the outside mail service.", permanent: false };
    }
  };
}
