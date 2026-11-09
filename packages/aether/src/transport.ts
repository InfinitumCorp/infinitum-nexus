/**
 * What a link layer (BLE, Wi-Fi Direct, LoRa bridge, internet relay, simulator) must provide.
 * Peers are identified by an opaque link id local to the transport, not by node key.
 */
export interface Transport {
  /** Link ids currently reachable. */
  peers(): string[];
  /** Best-effort send; delivery is not guaranteed. */
  send(peer: string, data: Uint8Array): void;
  onReceive(handler: (peer: string, data: Uint8Array) => void): void;
  onPeerUp(handler: (peer: string) => void): void;
  onPeerDown(handler: (peer: string) => void): void;
}
