/**
 * Conductor instrument adapters.
 * Real adapters (browser, HTTP APIs, Spectre, etc.) register here.
 */
import { registerInstrument, type Instrument } from "./executor.ts";

export const researchInstrument: Instrument = {
  name: "research",
  async execute(input) {
    const query = String(input.query ?? "").trim();
    if (!query) return { output: { error: "empty query" }, evidence: [] };
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { "user-agent": "InfinitumConductor/0.1" } });
      const html = await res.text();
      const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1].trim()).slice(0, 5);
      return {
        output: { summary: titles[0] ?? `No result for ${query}`, titles, query },
        evidence: [`research:${query}`, ...titles.map((t) => `title:${t.slice(0, 40)}`)],
      };
    } catch (err) {
      return { output: { error: String(err), query }, evidence: [`research-error:${query}`] };
    }
  },
};

export const spectreInstrument: Instrument = {
  name: "spectre",
  async execute(input) {
    // Placeholder that can later call the Spectre HTTP API
    return {
      output: { action: "spectre-call", input, status: "stub" },
      evidence: ["spectre:invoked"],
    };
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
