// © Infinitum Corporation®. All rights reserved.
/**
 * Collection contracts: which products may send which event types, with which payload
 * fields, for which purposes. Anything not listed here is rejected by the gateway.
 *
 * The gateway assigns each event its classification from this registry; clients cannot
 * lower it.
 */
import type { Classification, Payload, Problem, Purpose } from "./envelope.ts";

/** `cid` fields hold a Cumulus ID on the wire; the gateway replaces them with the tenant-scoped pseudonym. */
export type FieldType = "string" | "integer" | "number" | "boolean" | "id" | "cid" | "media_type" | "timestamp";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Upper bound for strings (characters) or numbers. */
  max?: number;
  /** The only value this field may take, e.g. `filtered: true`. */
  equals?: string | number | boolean;
}

export interface EventContract {
  /** Short description for the catalog. */
  description: string;
  fields: Record<string, FieldSpec>;
  purposes: Purpose[];
  classification: Classification;
  /** Raw-zone retention for this event type. */
  retentionDays: number;
  /** Event types that must carry object_id. */
  requiresObject?: boolean;
  /** Event types that must carry a subject (a Cumulus ID, pseudonymized by the gateway). */
  requiresSubject?: boolean;
}

export interface ProductContract {
  product: string;
  /** Data from this product is only collected after the person opts in (VEIL). */
  optInOnly?: boolean;
  events: Record<string, EventContract>;
}

/**
 * Military and defense products never feed the shared platform. This mirrors the policy in
 * @infinitum/data-exchange ("Military/ODIN° data is excluded by policy").
 */
export const EXCLUDED_PRODUCTS: ReadonlySet<string> = new Set(["aether", "aether-mil", "argus", "argus-mil", "eon", "odin"]);

/**
 * Field names that would carry message bodies, document text, secrets or precise location.
 * Rejected in every payload, whatever a contract says, so a mistaken contract can't widen
 * collection to content.
 */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  "body",
  "html",
  "text",
  "plaintext",
  "content",
  "subject_line",
  "attachment",
  "attachments",
  "message",
  "password",
  "passcode",
  "pin",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "seed",
  "private_key",
  "email",
  "phone",
  "ip",
  "ip_address",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "url",
  "history",
  "geohash",
  "plus_code",
  "location",
  "coordinates",
  "media",
  "raw",
]);

const media: FieldSpec = { type: "media_type" };

export const CONTRACTS: Record<string, ProductContract> = {
  "cumulus-id": {
    product: "cumulus-id",
    events: {
      "account.created": {
        description: "A Cumulus ID was created.",
        fields: { method: { type: "string", max: 32 } },
        purposes: ["service_operation", "security"],
        classification: "confidential",
        retentionDays: 400,
        requiresSubject: true,
      },
      "membership.granted": {
        description: "A Cumulus ID joined an organization.",
        fields: { organization_id: { type: "id", required: true }, role: { type: "string", max: 32 } },
        purposes: ["service_operation", "security"],
        classification: "confidential",
        retentionDays: 400,
        requiresSubject: true,
      },
      "membership.revoked": {
        description: "A Cumulus ID left an organization.",
        fields: { organization_id: { type: "id", required: true } },
        purposes: ["service_operation", "security"],
        classification: "confidential",
        retentionDays: 400,
        requiresSubject: true,
      },
    },
  },
  "cumulus-cloud": {
    product: "cumulus-cloud",
    events: {
      "file.uploaded": {
        description: "A file finished uploading to Cumulus://Cloud.",
        fields: {
          size_bytes: { type: "integer", required: true, max: 1e13 },
          media_type: { ...media, required: true },
          version: { type: "integer", max: 1e9 },
          folder_id: { type: "id" },
          sha256: { type: "string", max: 64 },
        },
        purposes: ["service_operation", "product_analytics", "billing"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "file.version_added": {
        description: "A new version of a file was stored.",
        fields: { size_bytes: { type: "integer", required: true, max: 1e13 }, version: { type: "integer", required: true, max: 1e9 } },
        purposes: ["service_operation", "product_analytics", "billing"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "file.shared": {
        description: "A file was shared with another Cumulus ID.",
        fields: { grantee_cid: { type: "cid", required: true }, role: { type: "string", required: true, max: 16 } },
        purposes: ["service_operation", "security"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "file.unshared": {
        description: "A share was removed.",
        fields: { grantee_cid: { type: "cid", required: true } },
        purposes: ["service_operation", "security"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "file.deleted": {
        description: "A file was permanently deleted. Propagates to every derived table and index.",
        fields: {},
        purposes: ["service_operation", "security", "product_analytics", "billing"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
    },
  },
  "cumulus-mail": {
    product: "cumulus-mail",
    events: {
      "message.delivered": {
        description: "Delivery outcome only. Message bodies and attachments are never collected here.",
        fields: {
          direction: { type: "string", required: true, max: 8 },
          latency_ms: { type: "integer", max: 86_400_000 },
          size_bytes: { type: "integer", max: 1e10 },
          attachment_count: { type: "integer", max: 1000 },
        },
        purposes: ["service_operation", "product_analytics"],
        classification: "internal",
        retentionDays: 180,
        requiresSubject: true,
      },
      "message.bounced": {
        description: "A delivery failed.",
        fields: { reason_code: { type: "string", required: true, max: 16 } },
        purposes: ["service_operation"],
        classification: "internal",
        retentionDays: 180,
        requiresSubject: true,
      },
    },
  },
  scalus: {
    product: "scalus",
    events: {
      "workflow.step_completed": {
        description: "One step of a Scalus/Conductor workflow finished. Secrets are never sent.",
        fields: {
          workflow_id: { type: "id", required: true },
          tool: { type: "string", required: true, max: 64 },
          status: { type: "string", required: true, max: 16 },
          duration_ms: { type: "integer", max: 86_400_000 },
          cost_microusd: { type: "integer", max: 1e12 },
        },
        purposes: ["service_operation", "billing", "product_analytics"],
        classification: "internal",
        retentionDays: 180,
        requiresSubject: true,
      },
      "workflow.feedback": {
        description: "A thumbs up or down on a workflow result.",
        fields: { workflow_id: { type: "id", required: true }, rating: { type: "integer", required: true, max: 1 } },
        purposes: ["product_analytics"],
        classification: "internal",
        retentionDays: 365,
        requiresSubject: true,
      },
    },
  },
  fabric: {
    product: "fabric",
    events: {
      "call.quality": {
        description: "Call quality measurements. Plaintext of end-to-end encrypted traffic is never collected.",
        fields: {
          duration_s: { type: "integer", max: 86_400 },
          jitter_ms: { type: "number", max: 10_000 },
          packet_loss_pct: { type: "number", max: 100 },
          codec: { type: "string", max: 16 },
        },
        purposes: ["service_operation", "product_analytics"],
        classification: "internal",
        retentionDays: 90,
      },
    },
  },
  veil: {
    product: "veil",
    optInOnly: true,
    events: {
      "diagnostics.reported": {
        description: "Opt-in product diagnostics. Browsing history is never collected.",
        fields: { app_version: { type: "string", required: true, max: 32 }, crash_count: { type: "integer", max: 1000 } },
        purposes: ["service_operation"],
        classification: "internal",
        retentionDays: 30,
      },
    },
  },
  hrvst: {
    product: "hrvst",
    // Harvest capture is personal by nature: nothing is collected until the person opts in.
    optInOnly: true,
    events: {
      "packet.created": {
        description:
          "A Harvest Packet passed the privacy filter. Media, text and location samples never leave HRVST; only this metadata.",
        fields: {
          media_type: { ...media, required: true },
          size_bytes: { type: "integer", max: 1e11 },
          filtered: { type: "boolean", required: true, equals: true },
          provenance_ref: { type: "id" },
        },
        purposes: ["service_operation", "product_analytics", "exchange_licensing"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "packet.kept": {
        description: "The owner kept a packet in their Personal Silo instead of licensing it.",
        fields: {},
        purposes: ["service_operation", "product_analytics"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
      "packet.licensed": {
        description: "The owner licensed a packet. Settlement details stay with Exchange and FIRM.",
        fields: { license_terms: { type: "string", required: true, max: 32 }, licensee_id: { type: "id", required: true } },
        purposes: ["billing", "exchange_licensing"],
        classification: "confidential",
        retentionDays: 3650,
        requiresObject: true,
        requiresSubject: true,
      },
      "packet.deleted": {
        description: "The owner withdrew a packet. Propagates to every derived table and index.",
        fields: {},
        purposes: ["service_operation", "product_analytics", "exchange_licensing", "billing"],
        classification: "confidential",
        retentionDays: 365,
        requiresObject: true,
        requiresSubject: true,
      },
    },
  },
  metatron: {
    product: "metatron",
    events: {
      "watchlist.changed": {
        description: "A watchlist changed. Licensed feed content is not copied here.",
        fields: { watchlist_id: { type: "id", required: true }, size: { type: "integer", max: 10_000 } },
        purposes: ["service_operation", "product_analytics"],
        classification: "confidential",
        retentionDays: 365,
        requiresSubject: true,
      },
    },
  },
  firm: {
    product: "firm",
    events: {
      "license.purchased": {
        description: "A dataset license was bought. Personal data stays off-chain; only settlement references.",
        fields: {
          license_id: { type: "id", required: true },
          dataset_id: { type: "id", required: true },
          amount_minor: { type: "integer", required: true, max: 1e15 },
          currency: { type: "string", required: true, max: 8 },
          settlement_ref: { type: "id" },
        },
        purposes: ["billing", "exchange_licensing"],
        classification: "restricted",
        retentionDays: 3650,
        requiresSubject: true,
      },
    },
  },
};

const MEDIA_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Names of the payload fields the gateway must pseudonymize. */
export function cidFields(contract: EventContract): string[] {
  return Object.entries(contract.fields).filter(([, f]) => f.type === "cid").map(([n]) => n);
}

export function contractFor(product: string, eventType: string): EventContract | undefined {
  return CONTRACTS[product]?.events[eventType];
}

/** Validates a payload against its contract. Unknown and forbidden fields are rejected. */
export function checkPayload(contract: EventContract, payload: Payload): Problem[] {
  const problems: Problem[] = [];
  for (const [name, value] of Object.entries(payload)) {
    const field = `payload.${name}`;
    if (FORBIDDEN_FIELDS.has(name.toLowerCase())) {
      problems.push({ field, message: "this field is never collected" });
      continue;
    }
    const spec = contract.fields[name];
    if (!spec) {
      problems.push({ field, message: "not in this event's contract" });
      continue;
    }
    if (value === null) {
      if (spec.required) problems.push({ field, message: "required" });
      continue;
    }
    const bad = (m: string) => problems.push({ field, message: m });
    if (spec.equals !== undefined && value !== spec.equals) {
      bad(`must be ${String(spec.equals)}`);
      continue;
    }
    switch (spec.type) {
      case "string":
        if (typeof value !== "string") bad("must be a string");
        else if (spec.max !== undefined && value.length > spec.max) bad(`longer than ${spec.max}`);
        break;
      case "id":
      case "cid":
        if (typeof value !== "string" || !ID_RE.test(value)) bad("must be an id");
        break;
      case "media_type":
        if (typeof value !== "string" || !MEDIA_RE.test(value)) bad("must be a media type");
        break;
      case "timestamp":
        if (typeof value !== "string" || Number.isNaN(Date.parse(value))) bad("must be a timestamp");
        break;
      case "boolean":
        if (typeof value !== "boolean") bad("must be a boolean");
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) bad("must be a non-negative integer");
        else if (spec.max !== undefined && value > spec.max) bad(`greater than ${spec.max}`);
        break;
      case "number":
        if (typeof value !== "number" || value < 0) bad("must be a non-negative number");
        else if (spec.max !== undefined && value > spec.max) bad(`greater than ${spec.max}`);
        break;
    }
  }
  for (const [name, spec] of Object.entries(contract.fields)) {
    if (spec.required && !(name in payload)) problems.push({ field: `payload.${name}`, message: "required" });
  }
  return problems;
}
