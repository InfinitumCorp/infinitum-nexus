// © Infinitum Corporation®. All rights reserved.
/**
 * The common event envelope every Infinitum product sends to the collection gateway.
 *
 * Clients send a ClientEvent. The gateway never trusts the permission fields a client
 * supplies: it derives `subject_id`, `classification` and `policy_ref` itself from
 * authoritative records and returns an Envelope.
 */

export const SCHEMA_VERSION = "1.0";

export const PURPOSES = [
  "service_operation",
  "security",
  "product_analytics",
  "billing",
  "research",
  "exchange_licensing",
] as const;
export type Purpose = (typeof PURPOSES)[number];

/** Ordered from least to most sensitive. */
export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

export type Scalar = string | number | boolean | null;
export type Payload = Record<string, Scalar>;

/** What a product's SDK sends. */
export interface ClientEvent {
  event_id: string;
  schema_version: string;
  product: string;
  event_type: string;
  occurred_at: string;
  tenant_id: string;
  /** The Cumulus ID of the person the event is about. The gateway pseudonymizes it and drops it. */
  subject_cid?: string;
  object_id?: string;
  purpose: Purpose;
  payload: Payload;
}

/** What the gateway stores after verification. Never contains a raw Cumulus ID. */
export interface Envelope {
  event_id: string;
  schema_version: string;
  product: string;
  event_type: string;
  occurred_at: string;
  received_at: string;
  tenant_id: string;
  subject_id: string | null;
  object_id: string | null;
  purpose: Purpose;
  policy_ref: string;
  classification: Classification;
  payload: Payload;
}

const CLIENT_FIELDS = new Set([
  "event_id",
  "schema_version",
  "product",
  "event_type",
  "occurred_at",
  "tenant_id",
  "subject_cid",
  "object_id",
  "purpose",
  "payload",
]);

/** Fields a client might try to set that only the gateway may set. */
const SERVER_ONLY_FIELDS = new Set(["subject_id", "classification", "policy_ref", "received_at"]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// RFC 3339 UTC with optional fractional seconds.
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

export interface Problem {
  field: string;
  message: string;
}

export class EnvelopeError extends Error {
  readonly problems: Problem[];
  constructor(problems: Problem[]) {
    super(problems.map((p) => `${p.field}: ${p.message}`).join("; "));
    this.name = "EnvelopeError";
    this.problems = problems;
  }
}

export function isId(v: unknown): v is string {
  return typeof v === "string" && ID_RE.test(v);
}

/** Structural validation of a client event. Product-specific payload rules live in schemas.ts. */
export function parseClientEvent(input: unknown): ClientEvent {
  const problems: Problem[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EnvelopeError([{ field: "$", message: "event must be a JSON object" }]);
  }
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (SERVER_ONLY_FIELDS.has(key)) problems.push({ field: key, message: "set by the gateway, not the client" });
    else if (!CLIENT_FIELDS.has(key)) problems.push({ field: key, message: "unknown field" });
  }
  if (!isId(o.event_id)) problems.push({ field: "event_id", message: "required id" });
  if (o.schema_version !== SCHEMA_VERSION) problems.push({ field: "schema_version", message: `must be ${SCHEMA_VERSION}` });
  if (!isId(o.product)) problems.push({ field: "product", message: "required id" });
  if (typeof o.event_type !== "string" || !EVENT_TYPE_RE.test(o.event_type)) {
    problems.push({ field: "event_type", message: "must look like noun.verb" });
  }
  if (typeof o.occurred_at !== "string" || !TIME_RE.test(o.occurred_at) || Number.isNaN(Date.parse(o.occurred_at))) {
    problems.push({ field: "occurred_at", message: "must be an RFC 3339 UTC timestamp" });
  }
  if (!isId(o.tenant_id)) problems.push({ field: "tenant_id", message: "required id" });
  if (o.subject_cid !== undefined && !isId(o.subject_cid)) problems.push({ field: "subject_cid", message: "must be an id" });
  if (o.object_id !== undefined && !isId(o.object_id)) problems.push({ field: "object_id", message: "must be an id" });
  if (typeof o.purpose !== "string" || !(PURPOSES as readonly string[]).includes(o.purpose)) {
    problems.push({ field: "purpose", message: `must be one of ${PURPOSES.join(", ")}` });
  }
  if (typeof o.payload !== "object" || o.payload === null || Array.isArray(o.payload)) {
    problems.push({ field: "payload", message: "must be an object" });
  } else {
    for (const [k, v] of Object.entries(o.payload as Record<string, unknown>)) {
      const scalar = v === null || ["string", "number", "boolean"].includes(typeof v);
      if (!scalar) problems.push({ field: `payload.${k}`, message: "must be a string, number, boolean or null" });
      if (typeof v === "number" && !Number.isFinite(v)) problems.push({ field: `payload.${k}`, message: "must be finite" });
    }
  }
  if (problems.length) throw new EnvelopeError(problems);
  return o as unknown as ClientEvent;
}
