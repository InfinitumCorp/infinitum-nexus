/**
 * HRVST Harvest Packet: a structured observation with provenance,
 * quality, permitted uses and an expiry.
 */

export interface HarvestPacket {
  id: string;
  ownerCid: string;
  /** What was observed (structured). */
  observation: string;
  /** Approximate location or "private". */
  location?: string;
  observedAt: string;
  /** Quality score 0..1. */
  quality: number;
  /** Permitted uses, e.g. ["mapping", "accessibility"]. */
  permittedUses: string[];
  expiresAt?: string;
  /** Firmament provenance entry hash (set after recording). */
  provenanceHash?: string;
}

export function createPacket(input: Omit<HarvestPacket, "id" | "observedAt"> & { observedAt?: string }): HarvestPacket {
  return {
    ...input,
    id: `pkt_${crypto.randomUUID()}`,
    observedAt: input.observedAt ?? new Date().toISOString(),
  };
}
