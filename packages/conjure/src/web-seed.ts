/**
 * Seed material from the web: when someone asks Conjure a question without supplying news or notes,
 * Infinitum Search finds and reads current pages and writes a cited brief, which becomes the seed.
 * The sources travel with the simulation so the report can show where the world model came from.
 */
import type { Search, Source } from "@infinitum/ai/search";
import { ConjureError } from "./conjure.ts";

export interface WebSeed {
  seed: string;
  sources: Pick<Source, "n" | "title" | "url">[];
  engine: string;
}

/** Search the web for `question` and turn the cited answer plus source snippets into seed text. */
export async function webSeed(search: Search, question: string, options: { signal?: AbortSignal } = {}): Promise<WebSeed> {
  const q = question.trim().slice(0, 500);
  if (!q) throw new ConjureError("Ask a question to forecast");
  const r = await search.ask(`Latest facts, positions and developments relevant to: ${q}`, { signal: options.signal });
  if (!r.sources.length) throw new ConjureError("Couldn't find anything on the web about that question. Paste some seed material instead.");
  const parts = [
    r.answer ? `Web brief (Infinitum Search, ${r.engine}):\n${r.answer}` : "",
    `Sources:\n${r.sources.map((s) => `[${s.n}] ${s.title} (${s.url})${s.snippet ? `: ${s.snippet}` : ""}`).join("\n")}`,
  ].filter(Boolean);
  return { seed: parts.join("\n\n").slice(0, 30_000), sources: r.sources.map((s) => ({ n: s.n, title: s.title, url: s.url })), engine: r.engine };
}
