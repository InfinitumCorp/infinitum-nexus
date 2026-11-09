/**
 * Record a Harvest Packet on Firmament for Proof of Perspective.
 */
import { Ledger, generateSigner } from "@infinitum/firmament";
import type { HarvestPacket } from "./packet.ts";
import { privacyFilter } from "./privacy.ts";

export async function recordPacket(ledger: Ledger, packet: HarvestPacket) {
  const observation = privacyFilter(packet.observation);
  const location = packet.location == null ? undefined : privacyFilter(packet.location);
  const signer = generateSigner();
  const entry = await ledger.append({
    type: "provenance",
    product: "hrvst",
    actor: packet.ownerCid,
    subject: `packet:${packet.id}`,
    payload: {
      packetId: packet.id,
      observation: observation.cleaned,
      redactions: [...observation.redactions, ...(location?.redactions ?? [])],
      quality: packet.quality,
      permittedUses: packet.permittedUses,
      location: location?.cleaned,
      observedAt: packet.observedAt,
    },
  }, signer);
  return {
    ...packet,
    observation: observation.cleaned,
    location: location?.cleaned,
    provenanceHash: entry.hash,
  };
}
