/**
 * Gmail-style search for Cumulus://Mail. Pure functions, shared by the page and its tests.
 *
 *   word  "exact phrase"  -exclude  from:  to:  subject:  in:inbox|sent|drafts|archive|trash|starred|anywhere
 *   is:unread  is:read  is:starred  has:file  has:attachment  has:payment  category:people|updates
 *   newer_than:3d  older_than:2w  (d, w, m, y)
 */

const BOXES = new Set(["inbox", "sent", "drafts", "archive", "trash", "starred", "anywhere", "all"]);
const UNITS = { d: 1, w: 7, m: 30, y: 365 };
const UPDATES = new Set(["newsletter", "notification", "receipt", "bounce"]);

/** Split a query into tokens, keeping "quoted phrases" whole and remembering a leading minus. */
export function tokenize(query) {
  const tokens = [];
  const re = /(-?)(?:([a-z_]+):)?(?:"([^"]*)"?|(\S+))/gi;
  for (const m of String(query).matchAll(re)) {
    const negate = m[1] === "-";
    const key = m[2]?.toLowerCase();
    const value = (m[3] ?? m[4] ?? "").toLowerCase();
    if (!key && !value) continue;
    tokens.push({ negate, key: key ?? "", value });
  }
  return tokens;
}

export function parseQuery(query) {
  const tokens = tokenize(query);
  const box = tokens.find((t) => t.key === "in" && !t.negate && BOXES.has(t.value))?.value;
  return { box: box === "all" ? "anywhere" : box, tokens: tokens.filter((t) => t.key !== "in" || t.negate || !BOXES.has(t.value)) };
}

const days = (value) => {
  const m = /^(\d+)([dwmy])$/.exec(value);
  return m ? Number(m[1]) * UNITS[m[2]] : null;
};
const person = (p) => `${p.name} ${p.email}`.toLowerCase();

function test(item, t, now) {
  const v = t.value;
  switch (t.key) {
    case "from": return person(item.from).includes(v);
    case "to": return [...item.to, ...(item.cc || [])].some((p) => person(p).includes(v));
    case "subject": return item.subject.toLowerCase().includes(v);
    case "in": return v === "starred" ? item.starred : item.folder === v;
    case "is":
      if (v === "unread") return item.unread;
      if (v === "read") return !item.unread;
      if (v === "starred") return item.starred;
      if (v === "verified" || v === "sealed") return Boolean(item.tunnel);
      return false;
    case "has":
      if (v === "file" || v === "attachment") return Boolean(item.attachments?.length);
      if (v === "payment") return Boolean(item.payment);
      if (v === "star") return item.starred;
      return false;
    case "category":
      if (v === "people" || v === "primary") return item.kind === "person";
      if (v === "updates") return UPDATES.has(item.kind);
      return item.kind === v;
    case "newer_than":
    case "older_than": {
      const d = days(v);
      if (d === null) return true;
      const age = (now - Date.parse(item.at)) / 86_400_000;
      return t.key === "newer_than" ? age <= d : age > d;
    }
    default: {
      const word = t.key ? `${t.key}:${v}` : v;
      const files = (item.attachments || []).map((f) => f.name).join(" ");
      return `${item.subject} ${item.body} ${person(item.from)} ${item.to.map(person).join(" ")} ${files}`.toLowerCase().includes(word);
    }
  }
}

/** Does one message match every token? */
export function matchesQuery(item, tokens, now = Date.now()) {
  return tokens.every((t) => test(item, t, now) !== t.negate);
}

/**
 * Search results, one row per conversation (its newest message in scope), newest first.
 * With no in: operator, search covers all mail except Trash and Drafts, the way Gmail does.
 */
export function searchThreads(messages, query, now = Date.now()) {
  const { box, tokens } = parseQuery(query);
  const scope = (m) =>
    !box ? m.folder !== "trash" && m.folder !== "drafts"
    : box === "anywhere" ? true
    : box === "starred" ? m.starred && m.folder !== "trash"
    : m.folder === box;
  const inScope = messages.filter(scope);
  const hit = new Set(inScope.filter((m) => matchesQuery(m, tokens, now)).map((m) => m.threadId));
  const latest = new Map();
  for (const m of inScope) {
    if (!hit.has(m.threadId)) continue;
    const prev = latest.get(m.threadId);
    if (!prev || prev.at < m.at) latest.set(m.threadId, m);
  }
  return [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Suggestions shown under the search box while it is focused and empty. */
export const SEARCH_TIPS = [
  ["is:unread", "Unread"],
  ["has:file", "With files"],
  ["has:payment", "With a payment"],
  ["is:starred", "Starred"],
  ["newer_than:7d", "Past week"],
  ["in:anywhere", "Include Trash"],
];
