/**
 * Architect instrument adapters.
 * Real adapters (browser, HTTP APIs, Spectre, etc.) register here.
 */
import { searchFromEnv, type Search } from "@infinitum/ai/search";
import { registerInstrument, type Instrument } from "./executor.ts";

const SPECTRE_BASE = process.env.SPECTRE_URL ?? "http://localhost:3000";

/** Infinitum Search from this process's environment (SEARXNG_URL / YANDEX_* / BRAVE_*), or null. */
let envSearch: Search | null | undefined;
export function searchFromProcessEnv(): Search | null {
  if (envSearch === undefined) {
    try {
      envSearch = searchFromEnv(process.env);
    } catch {
      envSearch = null;
    }
  }
  return envSearch;
}

/**
 * research: a Perplexity-style cited answer from Infinitum Search (engine → read the top pages →
 * answer with [n] citations checked against the sources). Without an engine it falls back to
 * DuckDuckGo result titles. Output keeps { summary, titles, query } for existing scores.
 */
export function createResearchInstrument(getSearch: () => Search | null = searchFromProcessEnv): Instrument {
  return {
    name: "research",
    async execute(input) {
      const query = String(input.query ?? "").trim().slice(0, 1000);
      if (!query) return { output: { error: "empty query" }, evidence: [] };
      if (process.env.ARCHITECT_RESEARCH_FIXTURE === "1") {
        return { output: { summary: "fixture", titles: ["fixture"], query }, evidence: [`research:${query}`] };
      }
      const search = getSearch();
      if (search) {
        try {
          const r = await search.ask(query);
          const sources = r.sources.map((s) => ({ n: s.n, title: s.title, url: s.url }));
          return {
            output: { summary: r.answer, answer: r.answer, cited: r.cited, sources, titles: sources.map((s) => s.title), engine: r.engine, query },
            evidence: [`research:${query}`, `engine:${r.engine}`, ...sources.filter((s) => r.cited.includes(s.n)).map((s) => `source:${s.url}`)],
          };
        } catch (err) {
          return { output: { error: err instanceof Error ? err.message : String(err), query }, evidence: [`research-error:${query}`] };
        }
      }
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { headers: { "user-agent": "InfinitumArchitect/0.1" } });
        const html = await res.text();
        const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1]!.trim()).slice(0, 5);
        return {
          output: { summary: titles[0] ?? `No result for ${query}`, titles, query, note: "Infinitum Search isn't connected; titles only." },
          evidence: [`research:${query}`, ...titles.map((t) => `title:${t.slice(0, 40)}`)],
        };
      } catch (err) {
        return { output: { error: String(err), query }, evidence: [`research-error:${query}`] };
      }
    },
  };
}

export const researchInstrument: Instrument = createResearchInstrument();

export const spectreInstrument: Instrument = {
  name: "spectre",
  async execute(input) {
    const path = String(input.path ?? "/api/companies");
    const method = String(input.method ?? "GET").toUpperCase();
    const url = `${SPECTRE_BASE}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(input.body ?? {}),
      });
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep text */ }
      return {
        output: { status: res.status, body, path },
        evidence: [`spectre:${method}:${path}`, `status:${res.status}`],
      };
    } catch (err) {
      return { output: { error: String(err), path }, evidence: [`spectre-error:${path}`] };
    }
  },
};

export const httpInstrument: Instrument = {
  name: "http",
  async execute(input) {
    const url = String(input.url ?? "").trim();
    if (!url) return { output: { error: "url required" }, evidence: [] };
    try {
      const method = String(input.method ?? "GET").toUpperCase();
      const res = await fetch(url, {
        method,
        headers: (input.headers as Record<string, string>) ?? {},
        body: method === "GET" ? undefined : JSON.stringify(input.body ?? {}),
      });
      const text = await res.text();
      return {
        output: { status: res.status, body: text.slice(0, 2000) },
        evidence: [`http:${url}`, `status:${res.status}`],
      };
    } catch (err) {
      return { output: { error: String(err), url }, evidence: [`http-error:${url}`] };
    }
  },
};

export function registerDefaultInstruments() {
  registerInstrument(researchInstrument);
  registerInstrument(spectreInstrument);
  registerInstrument(httpInstrument);
}
