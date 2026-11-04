/**
 * Real tool backends for Spectre agents.
 * web_search uses a public DuckDuckGo HTML endpoint (no API key).
 * firmament_lookup queries the actual ledger.
 * crm_query uses the live CRM.
 */
import type { Tool } from "@infinitum/scalus";
import type { Ledger } from "@infinitum/firmament";
import type { SpectreCRM } from "./crm.ts";
import { parseResults, summarize, type RawResult } from "./research-parser.ts";

export interface ToolDeps {
  ledger?: Ledger;
  crm?: SpectreCRM;
  workspace?: string;
}

export function createTools(deps: ToolDeps = {}): Record<string, Tool> {
  return {
    web_search: {
      name: "web_search",
      description: "Search for public company info",
      async execute(input) {
        const q = String(input.prompt ?? "").trim();
        if (!q) return { error: "empty query" };
        try {
          const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
          const res = await fetch(url, {
            headers: { "user-agent": "InfinitumSpectre/0.1" },
          });
          const html = await res.text();
          const titles = [...html.matchAll(/<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1].trim()).slice(0, 8);
          const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([^<]+)<\/a>/gi)].map((m) => m[1].trim()).slice(0, 8);
          const hrefs = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/gi)].map((m) => m[1]).slice(0, 8);
          const raw: RawResult[] = titles.map((title, i) => ({
            title,
            snippet: snippets[i],
            url: hrefs[i],
          }));
          const facts = parseResults(raw);
          return {
            summary: summarize(facts, q),
            facts,
            query: q,
          };
        } catch (err) {
          return { error: String(err), query: q };
        }
      },
    },

    firmament_lookup: {
      name: "firmament_lookup",
      description: "Check prior provenance on Firmament",
      async execute(input) {
        if (!deps.ledger) return { priorFacts: [], note: "no ledger" };
        const subject = String(input.subject ?? "");
        const entries = subject
          ? await deps.ledger.query({ product: "spectre", subject })
          : await deps.ledger.entries();
        return {
          priorFacts: entries.slice(-10).map((e) => ({
            type: e.type,
            subject: e.subject,
            actor: e.actor,
            timestamp: e.timestamp,
            payload: e.payload,
          })),
        };
      },
    },

    icp_match: {
      name: "icp_match",
      description: "Match companies against ICP",
      async execute() {
        if (!deps.crm || !deps.workspace) {
          return { suggestions: [] };
        }
        const companies = deps.crm.list("companies", deps.workspace);
        return {
          suggestions: companies.slice(0, 5).map((c) => ({
            name: c.name,
            domain: c.domain,
            reason: "Existing account in workspace",
          })),
        };
      },
    },

    rehearse: {
      name: "rehearse",
      description: "Simulate a deal conversation",
      async execute(input) {
        const scenario = String(input.prompt ?? "");
        return {
          scenario,
          likelyObjections: ["Price", "Timing", "Existing vendor", "Need internal buy-in"],
          suggestedResponse: "Lead with a specific outcome and a low-friction next step",
          nextBestAction: "Book a 20-minute working session",
        };
      },
    },

    crm_query: {
      name: "crm_query",
      description: "Answer questions about the current workspace",
      async execute() {
        if (!deps.crm || !deps.workspace) return { error: "CRM not available" };
        const deals = deps.crm.list("deals", deps.workspace);
        const companies = deps.crm.list("companies", deps.workspace);
        const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");
        return {
          openDeals: open.length,
          companies: companies.length,
          totalPipeline: open.reduce((s, d) => s + (d.amount ?? 0), 0),
          deals: open.slice(0, 10).map((d) => ({ id: d.id, name: d.name, stage: d.stage, amount: d.amount })),
        };
      },
    },
  };
}
