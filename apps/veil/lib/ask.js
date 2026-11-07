/**
 * VEIL Ask. The sidebar sends the text to CNDCTR (apps/architect) and does not
 * run packages/scalus. Autonomy is rehearsal: the extension cannot raise it.
 */
import { resolveOrigins } from "./nexus.js";

export async function submitAsk({ origin, text, page, fetchImpl = globalThis.fetch, dev }) {
  const base = resolveOrigins({ architect: origin }, { dev }).architect;
  const intent = page
    ? `${text}\n\n(Page the user shared: ${page.title ?? ""} — ${page.url ?? ""})`
    : String(text ?? "");
  const response = await fetchImpl(`${base}/api/perform`, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, autonomy: "rehearsal" }),
  });
  if (!response.ok) throw new Error(`Architect answered ${response.status}`);
  return response.json();
}
