/**
 * VEIL download safety. Decides from the file name, the server's MIME type
 * and the source URL whether a download should be paused for the user.
 * Nothing is uploaded or scanned remotely.
 *
 * The browser's downloads API does not expose file bytes, so this is a
 * name/type check, not content sniffing.
 */

/** Extensions that run code when opened. */
export const EXECUTABLE = Object.freeze([
  "exe", "msi", "msix", "appx", "scr", "com", "pif", "bat", "cmd", "ps1", "vbs", "vbe", "js", "jse",
  "wsf", "wsh", "hta", "cpl", "jar", "lnk", "reg", "dll", "apk", "xapk", "dmg", "pkg", "app",
  "command", "sh", "run", "bin", "deb", "rpm", "appimage", "iso", "img",
]);

/** Extensions people expect to be documents or media. */
export const DOCUMENT = Object.freeze([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "jpg", "jpeg", "png",
  "gif", "webp", "mp3", "mp4", "mov", "zip",
]);

const EXEC_MIME = /^(application\/(x-msdownload|x-msdos-program|x-ms-installer|x-msi|vnd\.microsoft\.portable-executable|x-dosexec|java-archive|vnd\.android\.package-archive|x-apple-diskimage|x-sh|x-executable)|text\/x-shellscript)$/i;
const DOC_MIME = /^(application\/pdf|image\/|audio\/|video\/|text\/plain|text\/csv)/i;

function extensions(filename) {
  const base = String(filename ?? "").split(/[\\/]/).pop().toLowerCase().trim();
  return base.split(".").slice(1).map((e) => e.replace(/[^a-z0-9]/g, "")).filter(Boolean);
}

/**
 * @param {{ filename?: string, mime?: string, url?: string }} d
 * @returns {{ risky: boolean, reasons: { kind: string, detail: string }[] }}
 */
export function assessDownload({ filename, mime, url } = {}) {
  const exts = extensions(filename);
  const last = exts.at(-1) ?? "";
  const reasons = [];
  const runs = EXECUTABLE.includes(last) || EXEC_MIME.test(String(mime ?? ""));
  if (exts.length >= 2 && DOCUMENT.includes(exts.at(-2)) && EXECUTABLE.includes(last)) {
    reasons.push({ kind: "double-extension", detail: `The name ends in .${exts.at(-2)}.${last}: it looks like a .${exts.at(-2)} but runs as a program.` });
  }
  if (DOCUMENT.includes(last) && EXEC_MIME.test(String(mime ?? ""))) {
    reasons.push({ kind: "type-mismatch", detail: `The name says .${last}, but the server sent a program (${mime}).` });
  } else if (EXECUTABLE.includes(last) && DOC_MIME.test(String(mime ?? ""))) {
    reasons.push({ kind: "type-mismatch", detail: `The server called this ${mime}, but the name ends in .${last}, which runs as a program.` });
  }
  if (runs && !reasons.length) reasons.push({ kind: "executable", detail: `.${last || "this file"} runs code when opened.` });
  let source = null;
  try {
    source = new URL(url);
  } catch { /* data: or blob: downloads */ }
  if (runs && source?.protocol === "http:" && !/(^|\.)onion$/i.test(source.hostname)) {
    reasons.push({ kind: "insecure-source", detail: `It came over plain HTTP from ${source.hostname}, so it could have been altered on the way.` });
  }
  return { risky: reasons.length > 0, reasons };
}
