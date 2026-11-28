/**
 * The Postfix side of Node-mode inbound mail: read the message from stdin, POST it to the
 * running Mail server's loopback listener (node-mail.ts), and exit with the code Postfix
 * understands. No imports beyond Node itself, so the pipe user needs nothing installed.
 *
 * sysexits: 0 delivered · 67 EX_NOUSER bounce "no such user" · 69 EX_UNAVAILABLE bounce
 *           · 75 EX_TEMPFAIL keep it queued and retry
 */
import { readFileSync } from "node:fs";

export const EX_OK = 0;
export const EX_NOUSER = 67;
export const EX_UNAVAILABLE = 69;
export const EX_TEMPFAIL = 75;

/** Postfix exit code for the listener's HTTP status. Unknown or server errors are retried. */
export function exitCodeFor(status: number): number {
  if (status === 200) return EX_OK;
  if (status === 404) return EX_NOUSER;
  if (status === 422 || status === 413) return EX_UNAVAILABLE;
  return EX_TEMPFAIL;
}

export interface PipeArgs {
  url: string;
  token: string;
  sender: string;
  recipient: string;
}

/** postfix-deliver.ts --url <url> (--token-file <path> | env MAIL_INBOUND_TOKEN) -- <sender> <recipient> */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): PipeArgs {
  const at = argv.indexOf("--");
  const flags = at >= 0 ? argv.slice(0, at) : argv;
  const rest = at >= 0 ? argv.slice(at + 1) : [];
  const flag = (name: string) => {
    const i = flags.indexOf(name);
    return i >= 0 ? flags[i + 1] : undefined;
  };
  const url = flag("--url") ?? env.MAIL_INBOUND_URL ?? "http://127.0.0.1:3011/inbound";
  const tokenFile = flag("--token-file") ?? env.MAIL_INBOUND_TOKEN_FILE;
  const token = (tokenFile ? readFileSync(tokenFile, "utf8") : env.MAIL_INBOUND_TOKEN ?? "").trim();
  if (rest.length !== 2) throw new Error("usage: postfix-deliver.ts --url <url> --token-file <file> -- ${sender} ${recipient}");
  if (!token) throw new Error("No inbound token: pass --token-file or set MAIL_INBOUND_TOKEN.");
  return { url, token, sender: rest[0]!, recipient: rest[1]! };
}

/** Hand one message to Mail. Returns the exit code and a line for Postfix's bounce or log. */
export async function deliverToMail(args: PipeArgs, raw: Uint8Array<ArrayBuffer>, fetchImpl: typeof fetch = fetch): Promise<{ code: number; message: string }> {
  const target = new URL(args.url);
  target.searchParams.set("sender", args.sender);
  target.searchParams.set("recipient", args.recipient);
  try {
    const res = await fetchImpl(target, {
      method: "POST",
      headers: { "Content-Type": "message/rfc822", "X-Cumulus-Inbound-Token": args.token },
      body: raw,
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { code: exitCodeFor(res.status), message: body.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { code: EX_TEMPFAIL, message: `Cumulus://Mail isn't reachable: ${(err as Error).message}` };
  }
}
