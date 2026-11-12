// © Infinitum Corporation®. All rights reserved.
/**
 * Compatibility with the Conjure contract in infra/data-platform/conjure/platform.yml
 * (CollectionService.ingest, POST /api/v1/collect/events).
 *
 * Products written against that contract send a Conjure EventEnvelope. This module maps it
 * to the native ClientEvent so every check in the gateway still applies:
 *
 *   - `consent` is a request, not a permission. It is mapped to a purpose that the policy
 *     service then verifies against authoritative records, exactly like a native event.
 *     An event asking for several consents is collected under the narrowest one.
 *   - `region` must match the region this gateway serves. EU and RU data are refused here
 *     so they can only land in their own region's stack.
 *   - `payload` must be flat scalars, as in the native contract; nested values are refused.
 *   - Request authentication stays HMAC signing (signing.ts), which is stricter than the
 *     bearer token the Conjure file names.
 */
import { SCHEMA_VERSION, type Purpose } from "./envelope.ts";
import type { IngestResult } from "./gateway.ts";

export const CONJURE_REGIONS = ["EU", "US", "RU"] as const;
export type ConjureRegion = (typeof CONJURE_REGIONS)[number];

/** Narrowest first: an event asking for several consents is collected under the first match. */
const CONSENT_TO_PURPOSE: [string, Purpose][] = [
  ["ESSENTIAL", "service_operation"],
  ["ANALYTICS", "product_analytics"],
  ["AI_IMPROVEMENT", "research"],
  ["EXCHANGE", "exchange_licensing"],
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conjure datetimes may carry an offset; the native envelope wants UTC with a Z. */
function toUtc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return null;
  return new Date(t).toISOString();
}

export function fromConjureEnvelope(raw: unknown, region: ConjureRegion): { event: unknown } | { error: string; event_id: string | null } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "event must be an object", event_id: null };
  const e = raw as Record<string, unknown>;
  const eventId = typeof e.eventId === "string" && UUID_RE.test(e.eventId) ? e.eventId.toLowerCase() : null;
  const err = (error: string) => ({ error, event_id: eventId });
  if (!eventId) return err("eventId must be a uuid");
  if (e.region !== region) return err(`this gateway stores ${region} data only; send ${String(e.region)} data to its own region`);
  if (e.schemaVersion !== 1) return err("schemaVersion must be 1");
  if (!Array.isArray(e.consent) || e.consent.length === 0) return err("consent must list at least one value");
  const asked = new Set(e.consent.map(String));
  const purpose = CONSENT_TO_PURPOSE.find(([c]) => asked.has(c))?.[1];
  if (!purpose) return err("consent has no known value");
  const occurredAt = toUtc(e.occurredAt);
  if (!occurredAt) return err("occurredAt must be a datetime");
  if (typeof e.eventType !== "string") return err("eventType is required");
  // Conjure names may be prefixed with the product (spectre.deal.stage_changed).
  const product = String(e.product ?? "");
  const eventType = e.eventType.startsWith(`${product}.`) ? e.eventType.slice(product.length + 1) : e.eventType;
  const known = new Set(["eventId", "product", "tenant", "cid", "eventType", "schemaVersion", "occurredAt", "region", "consent", "objectType", "objectId", "payload"]);
  for (const k of Object.keys(e)) if (!known.has(k)) return err(`unknown field ${k}`);
  return {
    event: {
      event_id: eventId,
      schema_version: SCHEMA_VERSION,
      product,
      event_type: eventType,
      occurred_at: occurredAt,
      tenant_id: e.tenant,
      ...(e.cid !== undefined && e.cid !== null ? { subject_cid: e.cid } : {}),
      ...(e.objectId !== undefined && e.objectId !== null ? { object_id: e.objectId } : {}),
      purpose,
      payload: e.payload ?? {},
    },
  };
}

/** The Conjure IngestResponse shape. */
export function toConjureResponse(r: IngestResult): { accepted: number; duplicates: number; rejected: { eventId: string | null; reason: string }[] } {
  return {
    accepted: r.accepted.length,
    duplicates: r.duplicates.length,
    rejected: r.rejected.map((x) => ({ eventId: x.event_id, reason: x.problems?.length ? `${x.reason}: ${x.problems.map((p) => `${p.field} ${p.message}`).join("; ")}` : x.reason })),
  };
}
