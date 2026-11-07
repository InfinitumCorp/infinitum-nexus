import { createHash } from "node:crypto";
import { id, utc, invalid } from "./validation.ts";
export function hash(input: unknown): string {
  if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input))
    return invalid("SHA-256 commit required");
  return input;
}
export function artifactPath(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,239}$/.test(input) ||
    input.split("/").some((p) => !p || p === "." || p === "..")
  )
    return invalid("Safe relative artifact path required");
  return input;
}
/** Private, non-spatial STAC-style metadata. Never fetches or publishes an external asset. */
export function catalogItem(
  input: {
    id: string;
    repo: string;
    product: "firmament" | "orbis";
    commit: string;
    path: string;
    observedAt: string;
    mediaType: unknown;
  },
  bytes: Uint8Array,
) {
  const identifier = id(input.id),
    repo = id(input.repo),
    commit = hash(input.commit),
    path = artifactPath(input.path),
    datetime = utc(input.observedAt);
  if (
    ![
      "application/json",
      "application/octet-stream",
      "image/tiff",
      "image/png",
      "text/csv",
    ].includes(input.mediaType as string)
  )
    invalid("Unsupported artifact media type");
  return {
    stac_version: "1.0.0",
    type: "Feature",
    id: identifier,
    geometry: null,
    properties: {
      datetime,
      "infinitum:product": input.product,
      "infinitum:simulation_only": true,
      "infinitum:operator_review_required": true,
      "infinitum:datetime_source": "client-supplied",
      "infinitum:source_commit": commit,
    },
    links: [],
    assets: {
      source: {
        href: `lbrnth://${repo}/${commit}/products/${input.product}/${path}`,
        type: input.mediaType,
        roles: ["data"],
        "infinitum:bytes": bytes.byteLength,
        "infinitum:sha256": createHash("sha256").update(bytes).digest("hex"),
      },
    },
  };
}
