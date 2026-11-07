import { LABYRINTH_PRODUCTS } from "@infinitum/lbrnth-client";
/** Product selection ported from scalvs/src/data.js; technical questions deliberately replace audience/persona framing. */
const sourceBrands: Record<string, string> = {
  scalvs: "SCALVS.ai",
  spectre: "+SPCTR",
  metatron: "METATRON¹⁰⁰",
  architect: "/CNDCTR/",
  odin: "ODIN°",
  argus: ">_ARGUS",
  aether: "ÆTHER",
  cloud: "Cumulus://Cloud",
  daemon: "DAEMON",
  eidetic: "ei·det·ic",
  eon: "E(O)N",
  fabric: "FABRIC",
  "firm-wallet": "FIRM Wallet",
  firmament: "Firmament Network",
  flower: "Flower",
  hrvst: "[HRVST]",
  orbis: "ORBIS",
  pollen: "POLLEN",
  slug: "SLUG",
  veil: "VEIL</>",
};
export const CONJURE_PRODUCT_PRESETS = Object.freeze(
  LABYRINTH_PRODUCTS.filter(
    (p) => p.implementation !== null && !("aliasOf" in p),
  ).map((p) =>
    Object.freeze({
      product: p.id,
      brand: sourceBrands[p.id] ?? p.name,
      sourcePreset: !!sourceBrands[p.id],
    }),
  ),
);
export type EvidenceKind =
  | "storage"
  | "telemetry"
  | "delivery"
  | "orbital"
  | "cyber"
  | "exercise";
export function productPreset(product: string, kind: EvidenceKind) {
  if (!CONJURE_PRODUCT_PRESETS.some((p) => p.product === product))
    throw new RangeError("No implemented product preset");
  if (
    (kind === "telemetry" &&
      !["daemon", "slug", "orbis", "pollen", "flower"].includes(product)) ||
    (kind === "orbital" && !["firmament", "orbis"].includes(product)) ||
    (kind === "cyber" && !["odin", "spectre", "veil"].includes(product)) ||
    (kind === "exercise" && product !== "eon") ||
    ![
      "storage",
      "telemetry",
      "delivery",
      "orbital",
      "cyber",
      "exercise",
    ].includes(kind)
  )
    throw new RangeError("Unsupported evidence profile");
  return {
    id: `conjure-${product}-${kind}-v1`,
    product,
    kind,
    question: `For ${product}, assess baseline, increased-load and mitigation-assumption scenarios using only the supplied aggregate ${kind} measurements. Identify uncertainty and missing evidence. Use synthetic nonhuman technical review agents only: no people, demographics, target tracks, persuasion or operational commands. This is qualitative scenario rehearsal, not calibrated failure, mission-success or security probabilities.`,
    dataSaleAllowed: false as const,
    requiresOperatorReview: true as const,
  };
}
