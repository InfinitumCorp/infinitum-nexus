/**
 * Spectre Researcher — uses real web_search tool backend.
 */
import { createTools } from "../core/tools.ts";

export interface ResearchResult {
  summary?: string;
  facts?: { field?: string; value?: string; source?: string }[];
  query?: string;
  error?: string;
}

export async function researchCompany(name: string): Promise<ResearchResult> {
  const tools = createTools();
  const result = await tools.web_search.execute({ prompt: name });
  if (!result || typeof result !== "object") return { error: "empty" };
  return result as ResearchResult;
}
