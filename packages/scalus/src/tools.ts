/**
 * SCALVS default tools.
 * Agents can import these or register their own.
 */
import type { Tool } from "./agent.ts";
import { searchFromEnv, type Search } from "@infinitum/ai/search";

export const echoTool: Tool = {
  name: "echo",
  description: "Echo the prompt",
  async execute(input) {
    return { echoed: input.prompt };
  },
};

/**
 * Web search for agents. With Infinitum Search connected (SEARXNG_URL, YANDEX_SEARCH_API_KEY +
 * YANDEX_FOLDER_ID, or BRAVE_SEARCH_API_KEY), it finds pages, reads the best ones and returns a short
 * answer with numbered citations plus the sources, Perplexity-style. Without an engine it falls back
 * to result titles from DuckDuckGo's HTML page, as before.
 */
export function createSearchTool(getSearch: () => Search | null = searchFromProcessEnv): Tool {
  return {
    name: "search",
    description: "Search the web and read the top pages. Returns a short answer with numbered citations [n] and the list of sources (title, url). Input: { query } or { prompt }.",
    async execute(input) {
      const q = String(input.query ?? input.prompt ?? "").trim().slice(0, 1000);
      if (!q) return { error: "empty query" };
      const search = getSearch();
      if (search) {
        try {
          const r = await search.ask(q);
          return { query: q, answer: r.answer, cited: r.cited, sources: r.sources.map((s) => ({ n: s.n, title: s.title, url: s.url })), engine: r.engine };
        } catch (err) {
          return { error: err instanceof Error ? err.message : "search failed", query: q };
        }
      }
      return duckDuckGoTitles(q);
    },
  };
}

let envSearch: Search | null | undefined;
/** Infinitum Search from this process's environment, or null when no engine is set. */
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

async function duckDuckGoTitles(q: string) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "user-agent": "SCALVS/0.1" } });
    const html = await res.text();
    const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1]!.trim()).slice(0, 5);
    return { titles, query: q, note: "Infinitum Search isn't connected; titles only." };
  } catch (err) {
    return { error: String(err), query: q };
  }
}

export const searchTool: Tool = createSearchTool();

export const noteTool: Tool = {
  name: "note",
  description: "Store a note",
  async execute(input) {
    return { stored: true, note: String(input.prompt ?? "") };
  },
};

export const defaultTools: Tool[] = [echoTool, searchTool, noteTool];
