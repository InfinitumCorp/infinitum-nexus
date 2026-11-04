/**
 * Spectre AI agent team (Researcher, Prospector, Deal Coach, Query, etc.).
 * Built on SCALVS agents. Plain-language queries route here.
 * Tools use real backends where available (web search, Firmament, CRM).
 */
import { runAgent, type Agent } from "@infinitum/scalus";
import type { SpectreCRM } from "./crm.ts";
import type { Ledger } from "@infinitum/firmament";
import { createTools, type ToolDeps } from "./tools.ts";

export interface AgentContext extends ToolDeps {}

export function createSpectreAgents(ctx: AgentContext = {}): Agent[] {
  const tools = createTools(ctx);

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
  const agents = (ctx.crm || ctx.ledger) ? createSpectreAgents(ctx) : SPECTRE_AGENTS;
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
