import type { OutboundResult, OutboundSend, PostOffice } from "@infinitum/mail";
import type { FileStore } from "./files.ts";

/**
 * Mail from Cumulus to addresses outside it, sent through Cloudflare Email Sending.
 * The cron trigger runs deliverOutbound() every minute: jobs are claimed in one transaction,
 * sent outside it (a slow mail server never holds the data store), and each outcome is recorded
 * the moment it's known. Messages go out as HTML with a plain-text alternative.
 */

/** The parts of Cloudflare's send_email binding that Cumulus uses. */
export interface EmailBinding {
  send(message: {
    to: string[];
    cc?: string[];
    from: { email: string; name?: string };
    subject: string;
    text: string;
    html?: string;
    headers?: Record<string, string>;
    attachments?: { content: Uint8Array; filename: string; type: string; disposition: "attachment" }[];
  }): Promise<{ messageId: string }>;
}

export type Sender = (job: OutboundSend) => Promise<OutboundResult>;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Plain text as simple, safe HTML: paragraphs, line breaks and clickable links. */
export function textToHtml(text: string): string {
  const linked = (line: string) =>
    escapeHtml(line).replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g, (url) => `<a href="${url}">${url}</a>`);
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 1em">${p.split("\n").map(linked).join("<br>")}</p>`);
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">${paragraphs.join("")}</body></html>`;
}

/** Errors that will fail the same way every time: tell the sender now instead of retrying. */
const PERMANENT: Record<string, string> = {
  E_VALIDATION_ERROR: "One of the addresses isn't a valid email address.",
  E_FIELD_MISSING: "The message was missing a recipient or subject.",
  E_TOO_MANY_RECIPIENTS: "Messages to outside addresses can have at most 50 recipients.",
  E_RECIPIENT_NOT_ALLOWED: "Sending to that address isn't allowed.",
  E_RECIPIENT_SUPPRESSED: "That address has bounced or reported spam before, so Cumulus won't send to it.",
  E_CONTENT_TOO_LARGE: "The message is too large to send outside Cumulus.",
  E_DELIVERY_FAILED: "The recipient's mail server refused the message.",
};

/** Email Sending refuses messages over 25 MiB; leave room for the text, HTML and encoding. */
const MAX_OUTBOUND_ATTACHMENTS = 24 * 1024 * 1024;

export function cloudflareSender(binding: EmailBinding, files?: FileStore): Sender {
  return async (job) => {
    let attachments: NonNullable<Parameters<EmailBinding["send"]>[0]["attachments"]> | undefined;
    if (job.attachments.length) {
      if (job.attachments.reduce((n, a) => n + a.size, 0) > MAX_OUTBOUND_ATTACHMENTS) {
        return { ok: false, error: "The attached files add up to more than 24 MB, which is too large to send outside Cumulus. Share them from Cloud instead.", permanent: true };
      }
      if (!files) return { ok: false, error: "Attachments can't be sent right now.", permanent: false };
      attachments = [];
      for (const a of job.attachments) {
        const file = await files.get(a.id);
        if (!file) return { ok: false, error: `The attached file "${a.name}" is no longer available.`, permanent: true };
        attachments.push({ content: file.data, filename: a.name, type: a.type ?? file.type, disposition: "attachment" });
      }
    }
    try {
      const { messageId } = await binding.send({
        to: job.to,
        cc: job.cc.length ? job.cc : undefined,
        from: job.from,
        subject: job.subject || "(no subject)",
        text: job.text,
        html: textToHtml(job.text),
        headers: { "X-Cumulus-Job": job.id },
        ...(attachments ? { attachments } : {}),
      });
      return { ok: true, providerId: messageId };
    } catch (err) {
      const code = String((err as { code?: unknown }).code ?? "");
      const permanent = PERMANENT[code];
      if (permanent) return { ok: false, error: permanent, permanent: true };
      console.error("Email Sending failed", code, (err as Error).message);
      return { ok: false, error: "Cumulus couldn't reach the outside mail service.", permanent: false };
    }
  };
}

/**
 * Claim due jobs, send them, and record each result as soon as it's known, so a run that stops
 * partway loses at most the jobs in flight (closed as unconfirmed, never re-sent). Returns how
 * many were sent.
 */
export async function deliverOutbound(
  transaction: <T>(fn: () => Promise<T>) => Promise<T>,
  mail: Pick<PostOffice, "claimOutbound" | "finishOutbound">,
  send: Sender,
  limit = 20,
): Promise<number> {
  const jobs = await transaction(async () => await mail.claimOutbound(limit));
  if (!jobs.length) return 0;
  const results = await Promise.all(
    jobs.map(async (job) => {
      const result: OutboundResult = await send(job).catch((err: unknown) => ({ ok: false, error: String((err as Error)?.message ?? err), permanent: false }));
      await transaction(async () => await mail.finishOutbound(job.id, result));
      return result;
    }),
  );
  return results.filter((r) => r.ok).length;
}
