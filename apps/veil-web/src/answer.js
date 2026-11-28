/**
 * VEIL Answers: a Perplexity-style answer on VEIL's own page. VEIL searches (its own index
 * first, then every other source it has), reads the best pages, and writes one short answer
 * that cites them as [1], [2]… The person never leaves VEIL to get the answer, and nothing
 * comes from Wikipedia or its mirrors.
 *
 * Everything here is plain functions so it can be tested without a Worker.
 */

/** Wikipedia, its sister projects and the sites that mirror it. Never searched, read or shown. */
const WIKI_HOSTS = /(^|\.)(wikipedia\.org|wikimedia\.org|wikidata\.org|wiktionary\.org|wikibooks\.org|wikiquote\.org|wikisource\.org|wikiversity\.org|wikivoyage\.org|wikinews\.org|mediawiki\.org|wikiwand\.com|wiki2\.org|dbpedia\.org|everybodywiki\.com|justapedia\.org|infogalactic\.com|wikizero\.com)$/i;

export function isWiki(url) {
  try {
    return WIKI_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A source's answer with every Wikipedia-family result taken out. */
export function noWiki(answer) {
  return answer ? { ...answer, results: answer.results.filter((r) => !isWiki(r.url)) } : answer;
}

export const MAX_SOURCES = 6;
export const PASSAGE_CHARS = 1400;
export const MAX_HISTORY = 3;
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text of an HTML page: the article if there is one, without scripts, menus or footers. */
export function pageText(html) {
  let h = String(html ?? "");
  const main = h.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 500) h = main[2];
  h = h
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|header|footer|aside|form|select|button)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decode(h).replace(/[ \t\f\v\r]+/g, " ").replace(/\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

/** The searched words (2+ letters or digits), lower case. */
export function terms(q) {
  return [...new Set(String(q ?? "").toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 12);
}

/**
 * The part of a page that best answers the question: the paragraph holding the most searched
 * words, widened with its neighbours up to about `max` characters.
 */
export function bestPassage(text, q, max = PASSAGE_CHARS) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t;
  const want = terms(q);
  const paras = t.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 30);
  if (!paras.length || !want.length) return t.slice(0, max);
  const score = (p) => {
    const low = p.toLowerCase();
    return want.reduce((n, w) => n + (low.includes(w) ? 1 : 0), 0) + Math.min(p.length, 400) / 4000;
  };
  let best = 0;
  paras.forEach((p, i) => { if (score(p) > score(paras[best])) best = i; });
  let out = paras[best].slice(0, max);
  for (let step = 1; out.length < max && (best - step >= 0 || best + step < paras.length); step++) {
    const after = paras[best + step];
    if (after && out.length + after.length + 1 <= max) out = out + "\n" + after;
    const before = paras[best - step];
    if (before && out.length + before.length + 1 <= max) out = before + "\n" + out;
  }
  return out;
}

/** Earlier turns of the conversation, trimmed: they give context, only the last question is answered. */
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((h) => h && typeof h.q === "string" && typeof h.a === "string")
    .slice(-MAX_HISTORY)
    .map((h) => ({ q: h.q.slice(0, 400), a: h.a.slice(0, 1500) }));
}

/** Question and filler words that search sources would otherwise require on every page. */
const STOP = new Set(("a an the and or but of to in on at by for from with about as into over is are was were be been being am " +
  "do does did doing done have has had can could should would will shall may might must " +
  "how what why when where which who whom whose whats hows " +
  "i me my we our you your it its this that these those there here them they their he she his her " +
  "tell explain show give please vs versus between any some more most best way ways get use using work works " +
  "different difference differences differ compare compared comparison like other else instead mean means " +
  "and also just really very much many if then than so not no yes " +
  "как что почему зачем когда где какой какая какие кто ли это в на и или не по для с о об у же бы").split(" "));

/** The words of a question worth searching for: question and filler words dropped, at most 8. */
export function keywords(q) {
  const all = terms(q);
  const kept = all.filter((w) => !STOP.has(w));
  return (kept.length ? kept : all).slice(0, 8).join(" ");
}

/**
 * What the search should look for: the question's keywords. A short follow-up such as "and on
 * Android?" means little on its own, so the previous question's keywords are put in front of it.
 */
export function searchQuery(q, history) {
  const last = history.length ? history[history.length - 1].q : "";
  const own = keywords(q);
  const short = own.split(" ").filter(Boolean).length <= 2;
  return (last && short ? keywords(last + " " + q) : own || q).slice(0, 400);
}

/**
 * Searches to try in order until one finds pages. Sources want every word on the page, so a
 * long or combined question is retried with fewer words: this question's own keywords, then
 * its first three, then its first two.
 */
export function searchPlan(q, history) {
  const own = keywords(q).split(" ").filter(Boolean);
  const plan = [searchQuery(q, history), own.join(" "), own.slice(0, 3).join(" "), own.slice(0, 2).join(" ")];
  return [...new Set(plan.filter(Boolean))];
}

const SYSTEM = `You are VEIL Answers, the private answer engine in the VEIL browser.
Answer the user's question using ONLY the numbered sources provided. Rules:
- Cite every fact with the number of its source in square brackets right after it, like [1] or [2][4]. Use only the numbers you were given.
- Lead with the direct answer in one or two sentences, then add detail. Keep it under 220 words unless the question needs steps or code.
- Use short paragraphs. Use "- " bullet lists or numbered steps when they make it clearer. Use **bold** sparingly. Use \`code\` for commands and code.
- If the sources don't answer the question, say so plainly in one sentence and say what they do cover. Never invent facts, links or numbers.
- Never mention Wikipedia, and never tell the user to search elsewhere.
- Write in the same language as the question.`;

/** The chat messages for the model: rules, earlier turns, then the sources and the question. */
export function buildMessages(q, sources, history = []) {
  const messages = [{ role: "system", content: SYSTEM }];
  for (const h of history) {
    messages.push({ role: "user", content: h.q });
    messages.push({ role: "assistant", content: h.a });
  }
  const numbered = sources.map((s, i) =>
    `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.passage || s.snippet || ""}`.trim()).join("\n\n");
  messages.push({ role: "user", content: `Sources:\n\n${numbered || "(no sources found)"}\n\nQuestion: ${q}` });
  return messages;
}

const RELATED_SYSTEM = `Suggest 3 follow-up questions a curious person would ask next, after the question below.
Each must name its subject explicitly (never "it" or "this"), go one step deeper or sideways from the original question, and make sense on its own.
Each must be a complete question under 80 characters, in the same language as the question.
Reply with the 3 questions only, one per line, no numbering, no other text.`;

export function relatedMessages(q, sources) {
  const titles = sources.slice(0, 5).map((s) => "- " + s.title).join("\n");
  return [
    { role: "system", content: RELATED_SYSTEM },
    { role: "user", content: `Question: ${q}\nSources found:\n${titles || "(none)"}` },
  ];
}

/** The model's reply as up to 3 clean questions. */
export function parseRelated(reply) {
  return String(reply ?? "")
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^"|"$/g, "").trim())
    .filter((l) => l.length > 8 && l.length <= 120 && /[?？]$/.test(l))
    .slice(0, 3);
}

/** Text out of one Workers AI streaming event (older models send `response`, newer ones OpenAI-style deltas). */
export function deltaOf(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.response === "string") return event.response;
  const c = event.choices && event.choices[0];
  return (c && c.delta && typeof c.delta.content === "string" && c.delta.content) || "";
}

/** Reads a server-sent-events stream (Workers AI's streaming reply), calling `onText` with each piece. Returns the whole text. */
export async function readSse(stream, onText) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let all = "";
  const line = (raw) => {
    const l = raw.trim();
    if (!l.startsWith("data:")) return;
    const data = l.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    const t = deltaOf(ev);
    if (t) { all += t; onText(t); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  line(buf + dec.decode());
  return all;
}

/** The text of a non-streamed Workers AI reply. */
export function replyText(out) {
  if (typeof out === "string") return out;
  if (out && typeof out.response === "string") return out.response;
  const c = out && out.choices && out.choices[0];
  return (c && c.message && typeof c.message.content === "string" && c.message.content) || "";
}
