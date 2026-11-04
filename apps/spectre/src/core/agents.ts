/**
 * Spectre AI agent team (Researcher, Prospector, Deal Coach, Query, etc.).
 * Built on SCALVS agents. Plain-language queries route here.
 */
import { runAgent, type Agent, type Tool } from "@infinitum/scalus";
import type { SpectreCRM } from "./crm.ts";

export interface AgentContext {
  crm?: SpectreCRM;
  workspace?: string;
}

export function createSpectreAgents(ctx: AgentContext = {}): Agent[] {
  const tools = {
    web_search: {
      name: "web_search",
      description: "Search for public company info",
      async execute(input: Record<string, unknown>) {
        const q = String(input.prompt ?? "");
        return {
          summary: `Public research summary for ${q}`,
          facts: [
            { field: "leadership", value: "Example CEO", source: "https://example.com" },
            { field: "news", value: `Recent mentions of ${q}`, source: "https://example.com/news" },
            { field: "industry", value: "Technology", source: "https://example.com" },
          ],
        };
      },
    } satisfies Tool,
    firmament_lookup: {
      name: "firmament_lookup",
      description: "Check prior provenance on Firmament",
      async execute() {
        return { priorFacts: [] };
      },
    } satisfies Tool,
    icp_match: {
      name: "icp_match",
      description: "Match companies against ICP",
      async execute() {
        return {
          suggestions: [
            { name: "Example Co", reason: "Matches industry + size", domain: "example.com" },
            { name: "Acme Labs", reason: "Similar tech stack", domain: "acmelabs.example" },
          ],
        };
      },
    } satisfies Tool,
    rehearse: {
      name: "rehearse",
      description: "Simulate a deal conversation",
      async execute(input: Record<string, unknown>) {
        return {
          scenario: String(input.prompt ?? ""),
          likelyObjections: ["Price", "Timing", "Existing vendor"],
          suggestedResponse: "Lead with a specific outcome and a low-friction next step",
          nextBestAction: "Book a 20-minute working session",
        };
      },
    } satisfies Tool,
    crm_query: {
      name: "crm_query",
      description: "Answer questions about the current workspace",
      async execute(input: Record<string, unknown>) {
        if (!ctx.crm || !ctx.workspace) return { error: "CRM not available" };
        const deals = ctx.crm.list("deals", ctx.workspace);
        const companies = ctx.crm.list("companies", ctx.workspace);
        return {
          openDeals: deals.filter((d) => !d.stage.startsWith("won") && d.stage !== "lost").length,
          companies: companies.length,
          totalPipeline: deals.reduce((s, d) => s + (d.amount ?? 0), 0),
        };
      },
    } satisfies Tool,
  };

  return [
    {
      id: "researcher",
      name: "Researcher",
      role: "Look up public facts about a company",
      tools: [tools.web_search, tools.firmament_lookup],
    },
    {
      id: "prospector",
      name: "Prospector",
      role: "Suggest new accounts and contacts that match ideal customer profile",
      tools: [tools.icp_match],
    },
    {
      id: "deal-coach",
      name: "Deal Coach",
      role: "Recommend next steps and rehearse deals",
      tools: [tools.rehearse],
    },
    {
      id: "query",
      name: "Query",
      role: "Answer plain-language questions over the CRM",
      tools: [tools.crm_query],
    },
  ];
}

export const SPECTRE_AGENTS = createSpectreAgents();

export async function runSpectreAgent(agentId: string, prompt: string, ctx: AgentContext = {}) {
  const agents = ctx.crm ? createSpectreAgents(ctx) : SPECTRE_AGENTS;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return runAgent(agent, prompt);
}

/** Simple router for plain-language queries. */
export function routeQuery(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("research") || t.includes("look up") || t.includes("find info")) return "researcher";
  if (t.includes("prospect") || t.includes("new account") || t.includes("icp")) return "prospector";
  if (t.includes("coach") || t.includes("next step") || t.includes("rehearse")) return "deal-coach";
  if (t.includes("how many") || t.includes("pipeline") || t.includes("open deals") || t.includes("list")) return "query";
  return "query";
}

/** Deal Rehearsal: run the coach agent against a deal description. */
export async function rehearseDeal(dealSummary: string, ctx: AgentContext = {}) {
  return runSpectreAgent("deal-coach", `rehearse ${dealSummary}`, ctx);
}
