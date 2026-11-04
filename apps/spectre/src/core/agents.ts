/**
 * Spectre AI agent team (Researcher, Prospector, Deal Coach, etc.).
 * Built on SCALVS agents. Plain-language queries route here.
 */
import { runAgent, type Agent, type Tool } from "@infinitum/scalus";

export const SPECTRE_AGENTS: Agent[] = [
  {
    id: "researcher",
    name: "Researcher",
    role: "Look up public facts about a company",
    tools: [
      {
        name: "web_search",
        description: "Search for public company info",
        async execute(input) {
          return { summary: `Public research for: ${input.prompt ?? ""}`, sources: [] };
        },
      },
    ],
  },
  {
    id: "prospector",
    name: "Prospector",
    role: "Suggest new accounts and contacts that match ideal customer profile",
    tools: [],
  },
  {
    id: "deal-coach",
    name: "Deal Coach",
    role: "Recommend next steps and rehearse deals",
    tools: [],
  },
  {
    id: "query",
    name: "Query",
    role: "Answer plain-language questions over the CRM",
    tools: [],
  },
];

export async function runSpectreAgent(agentId: string, prompt: string) {
  const agent = SPECTRE_AGENTS.find((a) => a.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  return runAgent(agent, prompt);
}

/** Simple router for plain-language queries. */
export function routeQuery(text: string): string {
  const t = text.toLowerCase();
  if (t.includes("research") || t.includes("look up") || t.includes("find info")) return "researcher";
  if (t.includes("prospect") || t.includes("new account") || t.includes("icp")) return "prospector";
  if (t.includes("coach") || t.includes("next step") || t.includes("rehearse")) return "deal-coach";
  return "query";
}
