/**
 * Product wordmarks, exactly as shown at https://infinitum-corporation.vercel.app/#products.
 * Product logos are these text marks. Do not rename them or drop a symbol.
 * `mark` is the name without ™; renderers add the raised ™.
 */

export type ProductId =
  | "argus" | "cndctr" | "scalvs" | "flower" | "nemesis" | "orbis" | "pollen"
  | "eidetic" | "hrvst" | "metatron" | "spectre" | "odin" | "aether" | "aether-mil"
  | "eon" | "fabric" | "veil" | "firm" | "firm-wallet" | "firmament" | "cumulus-cloud"
  | "cumulus-id" | "throne" | "throne-mil";

export interface Wordmark {
  id: ProductId;
  /** Plain name for alt text, slugs and speech. */
  name: string;
  /** The text logo without the ™. */
  mark: string;
  /** Text after the ™, for editions (e.g. "MIL"). */
  edition?: string;
}

export const WORDMARKS: readonly Wordmark[] = [
  { id: "argus", name: "Argus", mark: ">_ARGUS" },
  { id: "cndctr", name: "Conductor", mark: "/CNDCTR/" },
  { id: "scalvs", name: "Scalvs", mark: "SCALVS.ai" },
  { id: "flower", name: "Flower", mark: "Flower" },
  { id: "nemesis", name: "Nemesis", mark: "NEMESIS" },
  { id: "orbis", name: "Orbis", mark: "ORBIS" },
  { id: "pollen", name: "Pollen", mark: "POLLEN" },
  { id: "eidetic", name: "Eidetic", mark: "ei·det·ic" },
  { id: "hrvst", name: "Harvest", mark: "[HRVST]" },
  { id: "metatron", name: "Metatron", mark: "METATRON¹⁰⁰" },
  { id: "spectre", name: "Spectre", mark: "+SPCTR" },
  { id: "odin", name: "Odin", mark: "ODIN°" },
  { id: "aether", name: "Aether", mark: "ÆTHER" },
  { id: "aether-mil", name: "Aether MIL", mark: "ÆTHER", edition: "MIL" },
  { id: "eon", name: "Eon", mark: "E(O)N" },
  { id: "fabric", name: "Fabric", mark: "FABRIC" },
  { id: "veil", name: "Veil", mark: "VEIL</>" },
  { id: "firm", name: "Firm", mark: "FIRM" },
  { id: "firm-wallet", name: "Firm Wallet", mark: "FIRM Wallet" },
  { id: "firmament", name: "Firmament Network", mark: "Firmament Network" },
  { id: "cumulus-cloud", name: "Cumulus Cloud", mark: "Cumulus://Cloud" },
  { id: "cumulus-id", name: "Cumulus ID", mark: "Cumulus://ID" },
  { id: "throne", name: "Throne", mark: "#THRONE" },
  { id: "throne-mil", name: "Throne MIL", mark: "#THRONE", edition: "MIL" },
];

const byId = new Map(WORDMARKS.map((w) => [w.id, w]));

export function wordmark(id: ProductId): Wordmark {
  const w = byId.get(id);
  if (!w) throw new Error(`Unknown product: ${id}`);
  return w;
}

/** Plain text with the ™ character, for titles, READMEs, metadata. */
export function wordmarkText(id: ProductId): string {
  const w = wordmark(id);
  return `${w.mark}™${w.edition ? ` ${w.edition}` : ""}`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML with the raised ™, styled by brand.css (`sup.tm`). */
export function wordmarkHtml(id: ProductId): string {
  const w = wordmark(id);
  const edition = w.edition ? ` ${escapeHtml(w.edition)}` : "";
  return `${escapeHtml(w.mark)}<sup class="tm">™</sup>${edition}`;
}
