/**
 * Searching VEIL's own index (D1 full-text search). Used by the infinitumveil.app Worker,
 * which binds the same database. Ranking: BM25 with title weighted most, and pages that
 * load fewer trackers rank higher.
 */
export const PAGE_SIZE = 10;
export const MAX_OFFSET = 9;

/** Words only, each quoted, so nothing the person types is read as FTS5 syntax. */
export function ftsQuery(q, joiner = " ") {
  const words = (String(q ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 8);
  return words.map((w) => `"${w}"`).join(joiner);
}

const SQL = `
  SELECT p.url, p.title, p.description,
         snippet(pages_fts, 2, '', '', ' … ', 24) AS snip,
         bm25(pages_fts, 10.0, 4.0, 1.0) + p.trackers * 0.3 AS rank
  FROM pages_fts
  JOIN pages p ON p.id = pages_fts.rowid
  JOIN hosts h ON h.host = p.host
  WHERE pages_fts MATCH ? AND h.blocked = 0
  ORDER BY rank
  LIMIT ? OFFSET ?`;

/**
 * Every searched word must be on the page: first in its title or description (what the page
 * is about), else anywhere on it. There is no "any one word" fallback: a page that mentions
 * only "pizza" is not an answer to "pizza dough recipe", and VEIL's results are shown first.
 */
export async function searchIndex(db, q, offset = 0) {
  const off = Number.isInteger(offset) && offset >= 0 && offset <= MAX_OFFSET ? offset : 0;
  const all = ftsQuery(q);
  let rows = [];
  let weak = false; // only passing mentions: the blend weights these like a specialist source
  if (all) {
    for (const match of ["{title description} : (" + all + ")", all]) {
      rows = (await db.prepare(SQL).bind(match, PAGE_SIZE + 1, off * PAGE_SIZE).all()).results;
      if (rows.length) break;
      weak = true;
    }
  }
  const results = rows.slice(0, PAGE_SIZE).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description || r.snip || "",
  }));
  const more = rows.length > PAGE_SIZE && off < MAX_OFFSET;
  return { results, next: more ? { offset: off + 1 } : null, ...(weak && results.length ? { weight: 0.5 } : {}) };
}
