/**
 * HRVST Personal Silo: user-controlled store for Harvest Packets
 * that the owner chooses not to license.
 */
import type { HarvestPacket } from "./packet.ts";

export class PersonalSilo {
  private readonly packets = new Map<string, HarvestPacket>();

  put(packet: HarvestPacket) {
    this.packets.set(packet.id, packet);
    return packet;
  }

  get(id: string) {
    return this.packets.get(id);
  }

  list(ownerCid: string) {
    return [...this.packets.values()].filter((p) => p.ownerCid === ownerCid);
  }

  remove(id: string) {
    return this.packets.delete(id);
  }
}
