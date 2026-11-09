import type { InboundMail } from "@infinitum/mail";
import { inboundKey, safeType, type FileStore } from "./files.ts";

/** The parts of a postal-mime parse result that Cumulus uses. */
export interface ParsedEmail {
  from?: { name?: string; address?: string };
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  subject?: string;
  date?: string;
  text?: string;
  html?: string;
  attachments?: { filename?: string | null; mimeType?: string; content: ArrayBuffer | string }[];
}

const people = (list: ParsedEmail["to"]) =>
  (list ?? []).filter((p) => p.address).map((p) => ({ name: (p.name ?? "").trim() || p.address!, email: p.address!.toLowerCase() }));

/** Plain text from an HTML-only message: drop styles, scripts and tags, keep line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Turns an Email Routing delivery into Cumulus inbound mail. The envelope sender and recipient
 * (SMTP MAIL FROM / RCPT TO) are what Cloudflare checked; header addresses are only for display.
 */
export function toInbound(envelopeFrom: string, envelopeTo: string, parsed: ParsedEmail): InboundMail {
  const date = parsed.date ? new Date(parsed.date) : undefined;
  return {
    from: { name: (parsed.from?.name ?? "").trim(), email: envelopeFrom.toLowerCase() },
    recipients: [envelopeTo.toLowerCase()],
    to: people(parsed.to),
    cc: people(parsed.cc),
    subject: (parsed.subject ?? "").trim() || "(no subject)",
    body: parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : ""),
    at: date && !Number.isNaN(date.getTime()) && date.getTime() <= Date.now() ? date.toISOString() : undefined,
    attachments: (parsed.attachments ?? []).map((a) => ({
      name: a.filename || "attachment",
      size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
    })),
  };
}

/** Save the files that came with outside mail, so the recipient can open them. */
export async function storeInboundFiles(mail: InboundMail, parsed: ParsedEmail, store: FileStore): Promise<InboundMail> {
  const list = parsed.attachments ?? [];
  const attachments = await Promise.all(
    list.map(async (a, i) => {
      const data = typeof a.content === "string" ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
      const id = inboundKey();
      const type = safeType(a.mimeType);
      await store.put(id, data, type);
      return { ...(mail.attachments?.[i] ?? { name: a.filename || "attachment", size: data.byteLength }), id, type };
    }),
  );
  return { ...mail, attachments };
}
