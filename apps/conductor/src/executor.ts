import type { Score, Step, StepResult, Performance } from "./score.ts";

/**
 * Minimal executor: runs steps in order, checks declared permissions,
 * collects evidence. Real instrument adapters (browser, APIs, Infinitum
 * products) plug in later.
 */

export interface Instrument {
  name: string;
  execute(input: Record<string, unknown>, permissions: Step["permissions"]): Promise<{ output: unknown; evidence: string[] }>;
}

const registry = new Map<string, Instrument>();

export function registerInstrument(inst: Instrument) {
  registry.set(inst.name, inst);
}

export async function perform(score: Score, granted: Set<string>): Promise<Performance> {
  const results: StepResult[] = [];
  const evidence: string[] = [];

  for (const step of score.steps) {
    const missing = step.permissions.filter((p) => !granted.has(`${p.resource}:${p.actions.join(",")}`));
    if (missing.length) {
      results.push({
        stepId: step.id,
        ok: false,
        error: `Missing permissions: ${missing.map((m) => m.resource).join(", ")}`,
        evidence: [],
      });
      continue;
    }
    const inst = registry.get(step.instrument);
    if (!inst) {
      results.push({ stepId: step.id, ok: false, error: `Unknown instrument: ${step.instrument}`, evidence: [] });
      continue;
    }
    try {
      const { output, evidence: ev } = await inst.execute(step.input, step.permissions);
      results.push({ stepId: step.id, ok: true, output, evidence: ev });
      evidence.push(...ev);
    } catch (e) {
      results.push({ stepId: step.id, ok: false, error: String(e), evidence: [] });
    }
  }

  const verified = results.every((r) => r.ok);
  return { scoreId: score.id, results, verified, evidence };
}
