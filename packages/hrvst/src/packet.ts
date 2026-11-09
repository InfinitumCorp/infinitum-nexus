/**
 * HRVST Harvest Packet.
 * Permissioned capture → privacy filter → provenance on Firmament.
 */
export interface HarvestPacket {
  id: string;
  owner: string;
  mediaType: string;
  filtered: boolean;
  provenanceHash: string;
  createdAt: string;
}

export function createPacket(owner: string, mediaType: string, rawHash: string): HarvestPacket {
  return {
    id: `hrv_${Date.now()}`,
    owner,
    mediaType,
    filtered: true,
    provenanceHash: rawHash,
    createdAt: new Date().toISOString(),
  };
}

export function privacyFilter(raw: string): string {
  const phone = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}\b/g;
  return raw.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email]")
            .replace(phone, "[phone]");
}
