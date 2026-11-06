/**
 * Record Architect performance evidence on Firmament.
 */
import { Ledger, generateSigner } from "@infinitum/firmament";
import type { Performance } from "./score.ts";

export async function recordEvidence(ledger: Ledger, performance: Performance, actor = "cid:architect") {
  const signer = generateSigner();
  return ledger.append({
    type: "audit",
    product: "architect",
    actor,
    subject: performance.scoreId,
    payload: {
      verified: performance.verified,
      evidence: performance.evidence,
      results: performance.results.map((r) => ({ stepId: r.stepId, ok: r.ok })),
    },
  }, signer);
}
