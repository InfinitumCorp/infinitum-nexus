/** Website product inventory. Brands without implementations remain explicit registry-only entries. */
export const LABYRINTH_PRODUCTS = [
  { id: "firm", name: "FIRM", implementation: "packages/firm" },
  { id: "daemon", name: "DAEMON", implementation: "packages/hardware + packages/autonomy" },
  { id: "architect", name: "ARCHITECT", implementation: "apps/architect; InfinitumCorp/architect" },
  { id: "veil", name: "VEIL", implementation: "apps/veil" },
  { id: "throne", name: "THRONE", implementation: null },
  { id: "spectre", name: "SPECTRE", implementation: "apps/spectre" },
  { id: "slug", name: "SLUG", implementation: "packages/hardware + packages/autonomy" },
  { id: "seraphim", name: "SERAPHIM", implementation: null },
  { id: "scalvs", name: "SCALVS", implementation: "packages/scalus" },
  { id: "tokens", name: "Project Tokens", implementation: "packages/firm" },
  { id: "pollen", name: "POLLEN", implementation: "packages/hardware + packages/autonomy" },
  { id: "orbis", name: "ORBIS", implementation: "packages/hardware + packages/autonomy" },
  { id: "odin", name: "ODIN", implementation: "InfinitumCorp/odin" },
  { id: "metatron", name: "METATRON", implementation: "packages/metatron" },
  { id: "hrvst", name: "HRVST", implementation: "packages/hrvst + apps/hrvst" },
  { id: "flower", name: "FLOWER", implementation: "packages/hardware + packages/autonomy" },
  { id: "firmament", name: "Firmament Network", implementation: "packages/firmament" },
  { id: "fabric", name: "FABRIC", implementation: "packages/fabric" },
  { id: "eon", name: "EON", implementation: "packages/eon; InfinitumCorp/eon" },
  { id: "eidetic", name: "EIDETIC", implementation: "packages/eidetic" },
  { id: "cumulus-exchange", name: "Cumulus Exchange", implementation: "packages/data-exchange + apps/data-exchange" },
  { id: "cherubim", name: "CHERUBIM", implementation: null },
  { id: "azrail", name: "AZRAIL", implementation: null },
  { id: "argus", name: "ARGUS", implementation: "packages/argus; InfinitumCorp/argus-military-reference" },
  { id: "aether", name: "AETHER", implementation: "packages/aether" },
  { id: "nemesis", name: "NEMESIS", implementation: null },
  { id: "firm-wallet", name: "FIRM Wallet", implementation: "packages/firm + packages/cumulus" },
  // CNDCTR is an earlier name of ARCHITECT, not a second client-data namespace.
  { id: "cndctr", name: "CNDCTR", implementation: "architect alias", aliasOf: "architect" },
  { id: "cumulus-mail", name: "Cumulus Mail", implementation: "apps/cumulus-mail; InfinitumCorp/cumulus-mail" },
  { id: "cumulus", name: "Cumulus", implementation: "packages/cumulus" },
  { id: "cloud", name: "Cumulus Cloud", implementation: "packages/cloud" },
  { id: "conjure", name: "Conjure", implementation: "packages/conjure" },
  // Third-party agent (OpenClaw) acting for the person with a repository-only lbrnth_ credential.
  // External: not an Infinitum app in CID; access is the LBRNTH plan and scopes of the person it acts for.
  { id: "openclaw", name: "OpenClaw", implementation: "packages/lbrnth-openclaw", external: true },
] as const;
export type LabyrinthProduct = (typeof LABYRINTH_PRODUCTS)[number]["id"];
const aliases: Readonly<Record<string, LabyrinthProduct>> = Object.freeze({ scalus: "scalvs", cndctr: "architect", architct: "architect", "project-tokens": "tokens", "firmament-network": "firmament", "e(o)n": "eon", "cumulus exchange": "cumulus-exchange" });
export function labyrinthProduct(value: string): LabyrinthProduct {
  if (typeof value !== "string") throw new Error("Unknown Labyrinth product");
  const id = value.toLowerCase();
  const canonical = Object.hasOwn(aliases, id) ? aliases[id] : id;
  if (!LABYRINTH_PRODUCTS.some(p => p.id === canonical)) throw new Error("Unknown Labyrinth product");
  return canonical as LabyrinthProduct;
}

/** Shared entitlement/auth contract; registry-only is not a claim of a running product. */
export function labyrinthIntegration(product: string) {
  const id = labyrinthProduct(product);
  const entry = LABYRINTH_PRODUCTS.find(p => p.id === id)!;
  return { ...entry, requiredEntitlement: "LBRNTH" as const, authentication: "cumulus-id" as const, scopes: ["repo:read", "repo:write", "repo:admin"] as const, status: entry.implementation === null ? "registry-only" as const : "adapter" as const };
}
