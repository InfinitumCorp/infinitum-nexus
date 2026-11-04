/**
 * Record Conductor performance evidence on Firmament.
 */
import { Ledger, generateSigner } from "@infinitum/firmament";
import type { Performance } from "./score.ts";

export async function recordEvidence(ledger: Ledger, performance: Performance, actor = "cid:conductor") {
  const signer = generateSigner();
  return ledger.append({
    type: "audit",
    product: "conductor",
    actor,
    subject: `score:${performance.scoreId}`,
    payload: {
      scoreId: performance.scoreId,
      verified: performance.verified,
      evidence: performance.evidence,
      results: performance.results.map((r) => ({ stepId: r.stepId, ok: r.ok })),
    },
  }, signer);
}
