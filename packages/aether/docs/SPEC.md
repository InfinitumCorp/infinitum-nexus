# ÆTHER™ mesh protocol — v0 (draft)

Status: M0 draft, implemented in `src/` (M1). Wire format may change until v1.

ÆTHER moves small signed packets between devices that can only reach a few
neighbours at a time (BLE, Wi-Fi Direct, LoRa, or an internet relay). There is
no global routing table: packets are flooded with a hop limit, de-duplicated,
and held for a while so they can be handed to peers that appear later
(store-and-forward). That is what lets a message cross a mesh whose links come
and go.

## Identity

- Every device has an Ed25519 key pair. The 32-byte raw public key **is** the
  node address. Its hex form is the node id; the first 8 bytes are the short id
  shown in logs.
- A device key can be enrolled against a Cumulus://ID (milestone M3). The mesh
  itself never needs an account: the free tier works with keys alone.
- Contacts exchange public keys offline by QR code (M2).

## Packet layout

All integers are unsigned big-endian.

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | magic | `0xAE 0x01` |
| 2 | 1 | version | `1` |
| 3 | 1 | type | `1` DATA, `2` RECEIPT |
| 4 | 1 | flags | reserved, must be `0` |
| 5 | 1 | ttl | hops left; **mutable**, not signed |
| 6 | 1 | hops | hops taken; **mutable**, not signed |
| 7 | 1 | reserved | must be `0` |
| 8 | 16 | msgId | random, unique per packet |
| 24 | 32 | src | sender public key |
| 56 | 32 | dst | recipient public key; all zero = broadcast |
| 88 | 8 | timestamp | sender clock, ms since Unix epoch |
| 96 | 2 | payloadLen | 0 – 4096 |
| 98 | n | payload | opaque bytes |
| 98+n | 64 | signature | Ed25519 by `src` |

Header = 98 bytes, overhead = 162 bytes plus payload.

The signature covers bytes `0 … 98+n` with `ttl` and `hops` set to zero, so
relays can decrement the hop limit without breaking the signature. A relay can
therefore lower `ttl` (shortening reach) or lie about `hops`; it cannot change
who sent the packet, who it is for, or what it says.

A RECEIPT is a packet whose payload is the 16-byte `msgId` it acknowledges,
signed by the recipient and addressed to the original sender.

## Node behaviour

On receiving bytes from a link peer:

1. Decode. Drop if malformed, wrong magic or version, or payload too large.
2. Drop if `msgId` is in the seen cache **and** this copy's `ttl` is not
   higher than the best `ttl` already seen for it. (Checked on the raw bytes
   before decoding and signature verification, so duplicates cost nothing.)
3. Verify the signature. Drop on failure **without** marking the id as seen,
   so a forged copy cannot block the real one.
4. Drop if the timestamp is more than the store window in the past or more than
   the allowed clock skew in the future.
5. Apply the per-source rate limit. Drop if exceeded.
6. Mark `msgId` as seen with this copy's `ttl`. If the id had been seen
   before, this is a **ttl upgrade**: under churn the first copy can arrive
   by a long detour with almost no hops left. Forward the new copy (step 8)
   but do not deliver it again or apply the rate limit, and stop here.
   Messages already acknowledged by a receipt are never re-forwarded.
7. If `dst` is this node: deliver, and send a RECEIPT. If `dst` is broadcast:
   deliver and continue. A RECEIPT addressed here clears the matching message
   from the outbox.
8. If `ttl > 0` and the packet is not addressed only to this node: forward a
   copy with `ttl - 1` and `hops + 1` to every link peer except the one it came
   from.
9. Keep the forwarded copy in the store for the store window.

When a new link peer appears, the node sends it every stored packet that has
not expired and has not been acknowledged. The peer's seen cache discards the
ones it already has.

Default parameters (all configurable):

| Parameter | Default |
| --- | --- |
| Initial TTL | 16 (max 32) |
| Store window | 6 hours |
| Store capacity | 512 packets per node |
| Seen cache | 24 hours, 8192 ids |
| Allowed future clock skew | 5 minutes |
| Rate limit | 120 packets/min per source, burst 240 |

## What v0 does not do yet

- **Confidentiality.** Payloads are signed but not encrypted. Link encryption
  (Noise XX) and end-to-end encryption (an audited Double Ratchet or MLS
  library) are the next step and will be added from vetted packages, not
  written here. Until then, do not carry private content over ÆTHER.
- Routing smarter than flooding. Flooding is right for small meshes; a
  distance-vector or gossip overlay comes when meshes grow past a few hundred
  nodes.
- Fragmentation of payloads larger than 4096 bytes (voice frames, map tiles).

## ÆTHER™ MIL

ÆTHER™ MIL nodes run this protocol on military-owned servers and gateways.
They never report to the data exchange (`AetherCollector`), never earn or
carry $AETHR rewards, and are not described in public token, data-sale or
marketing material unless a person approves it (//RULES// §7).
