export interface SniffedType {
  /** Type we are willing to put on the response. */
  mediaType: string;
  /** True only for types that are safe to render inline in a browser. */
  inline: boolean;
}

const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain"]);

/**
 * Active content is never served as itself. HTML, SVG, and XML downloads are
 * application/octet-stream with an attachment disposition so a shared link
 * cannot run a script in the Cumulus origin.
 */
export function sniff(prefix: Buffer, declared: string): SniffedType {
  const detected = detect(prefix);
  const declaredBase = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (isActive(detected) || isActive(declaredBase)) {
    return { mediaType: "application/octet-stream", inline: false };
  }
  if (detected === "text/plain") {
    return { mediaType: "text/plain; charset=utf-8", inline: false };
  }
  if (detected === "application/octet-stream") {
    return { mediaType: "application/octet-stream", inline: false };
  }
  return { mediaType: detected, inline: INLINE.has(detected) };
}

function isActive(type: string): boolean {
  return (
    type === "text/html" ||
    type === "image/svg+xml" ||
    type === "image/svg" ||
    type === "application/xhtml+xml" ||
    type === "text/xml" ||
    type === "application/xml" ||
    type === "application/javascript" ||
    type === "text/javascript"
  );
}

function detect(prefix: Buffer): string {
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return "image/jpeg";
  if (prefix.length >= 6 && (prefix.subarray(0, 6).toString("ascii") === "GIF87a" || prefix.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (prefix.length >= 5 && prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b) return "application/gzip";
  if (prefix.length >= 4 && prefix.subarray(0, 2).toString("ascii") === "PK") return "application/zip";
  const sample = prefix.subarray(0, Math.min(prefix.length, 256)).toString("utf8").trimStart().toLowerCase();
  if (/^<!doctype\s+html/.test(sample) || /^<html[\s>]/.test(sample) || /^<script[\s>]/.test(sample)) return "text/html";
  if (/^<svg[\s>]/.test(sample) || sample.startsWith("<?xml")) return "image/svg+xml";
  if (prefix.length === 0) return "application/octet-stream";
  if (looksLikeText(prefix)) return "text/plain";
  return "application/octet-stream";
}

function looksLikeText(prefix: Buffer): boolean {
  const n = Math.min(prefix.length, 512);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = prefix[i] ?? 0;
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) odd++;
  }
  return odd / n < 0.05;
}
