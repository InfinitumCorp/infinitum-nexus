/**
 * Record a Harvest Packet on Firmament for Proof of Perspective.
 */
import { Ledger, generateSigner } from "@infinitum/firmament";
import type { HarvestPacket } from "./packet.ts";
import { privacyFilter } from "./privacy.ts";

export async function recordPacket(ledger: Ledger, packet: HarvestPacket) {
  const { cleaned, redactions } = privacyFilter(packet.observation);
  const signer = generateSigner();
  const entry = await ledger.append({
    type: "hrvst.packet",
    actor: packet.ownerCid,
    data: {
      packetId: packet.id,
      observation: cleaned,
      redactions,
      quality: packet.quality,
      permittedUses: packet.permittedUses,
      location: packet.location,
      observedAt: packet.observedAt,
    },
  }, signer);
  return { ...packet, observation: cleaned, provenanceHash: entry.hash };
}
