/**
 * Richer research parsing: turn raw search results into structured facts.
 */
export interface RawResult {
  title: string;
  snippet?: string;
  url?: string;
}

export interface ParsedFact {
  field: string;
  value: string;
  source: string;
}

const PATTERNS: { field: string; re: RegExp }[] = [
  { field: "leadership", re: /\b(CEO|CTO|CFO|founder|president|VP)\b/i },
  { field: "funding", re: /\b(raised|funding|series [a-d]|seed|valuation)\b/i },
  { field: "news", re: /\b(announced|launched|acquired|partnership|award)\b/i },
  { field: "industry", re: /\b(industry|sector|market)\b/i },
  { field: "headcount", re: /\b(\d+[,\d]*\s*(employees|staff|people))\b/i },
];

export function parseResults(results: RawResult[]): ParsedFact[] {
  const facts: ParsedFact[] = [];
  for (const r of results) {
    const text = `${r.title} ${r.snippet ?? ""}`;
    for (const p of PATTERNS) {
      if (p.re.test(text)) {
        facts.push({
          field: p.field,
          value: r.title,
          source: r.url ?? r.snippet ?? "search",
        });
        break;
      }
    }
    // Always keep a generic search_result if nothing matched
    if (!facts.some((f) => f.value === r.title)) {
      facts.push({
        field: "search_result",
        value: r.title,
        source: r.url ?? r.snippet ?? "search",
      });
    }
  }
  return facts.slice(0, 10);
}

export function summarize(facts: ParsedFact[], query: string): string {
  const byField = new Map<string, string[]>();
  for (const f of facts) {
    const arr = byField.get(f.field) ?? [];
    arr.push(f.value);
    byField.set(f.field, arr);
  }
  const parts = [...byField.entries()].map(([k, v]) => `${k}: ${v[0]}`);
  return parts.length ? parts.join("; ") : `No structured facts for ${query}`;
}
