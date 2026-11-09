/**
 * ÆTHER wire format v1. See docs/SPEC.md for the layout.
 */
import { randomBytes } from "node:crypto";
import { PUBLIC_KEY_BYTES, SIGNATURE_BYTES, toHex, verifySignature, type Identity } from "./identity.ts";

export const MAGIC_0 = 0xae;
export const MAGIC_1 = 0x01;
export const VERSION = 1;
export const HEADER_BYTES = 98;
export const MSG_ID_BYTES = 16;
export const MAX_PAYLOAD = 4096;
export const MAX_TTL = 32;

export const PacketType = { Data: 1, Receipt: 2 } as const;
export type PacketType = (typeof PacketType)[keyof typeof PacketType];

export const BROADCAST: Uint8Array = new Uint8Array(PUBLIC_KEY_BYTES);

export interface Packet {
  type: PacketType;
  ttl: number;
  hops: number;
  msgId: Uint8Array;
  src: Uint8Array;
  dst: Uint8Array;
  timestamp: number;
  payload: Uint8Array;
  signature: Uint8Array;
}

export class PacketError extends Error {}

export interface BuildOptions {
  type?: PacketType;
  ttl?: number;
  timestamp?: number;
  msgId?: Uint8Array;
}

export function buildPacket(identity: Identity, dst: Uint8Array, payload: Uint8Array, opts: BuildOptions = {}): Packet {
  if (dst.length !== PUBLIC_KEY_BYTES) throw new PacketError("dst must be a 32-byte public key");
  if (payload.length > MAX_PAYLOAD) throw new PacketError(`payload exceeds ${MAX_PAYLOAD} bytes`);
  const ttl = opts.ttl ?? 16;
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_TTL) throw new PacketError(`ttl must be 0..${MAX_TTL}`);
  const msgId = opts.msgId ?? new Uint8Array(randomBytes(MSG_ID_BYTES));
  if (msgId.length !== MSG_ID_BYTES) throw new PacketError("msgId must be 16 bytes");
  const packet: Packet = {
    type: opts.type ?? PacketType.Data,
    ttl,
    hops: 0,
    msgId,
    src: identity.publicKey,
    dst,
    timestamp: Math.floor(opts.timestamp ?? Date.now()),
    payload,
    signature: new Uint8Array(SIGNATURE_BYTES),
  };
  packet.signature = identity.sign(signedBytes(packet));
  return packet;
}

/** Header + payload with the mutable ttl/hops fields zeroed: the bytes the signature covers. */
export function signedBytes(p: Packet): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES + p.payload.length);
  writeHeader(buf, p, 0, 0);
  buf.set(p.payload, HEADER_BYTES);
  return buf;
}

export function encodePacket(p: Packet): Uint8Array {
  const buf = new Uint8Array(HEADER_BYTES + p.payload.length + SIGNATURE_BYTES);
  writeHeader(buf, p, p.ttl, p.hops);
  buf.set(p.payload, HEADER_BYTES);
  buf.set(p.signature, HEADER_BYTES + p.payload.length);
  return buf;
}

function writeHeader(buf: Uint8Array, p: Packet, ttl: number, hops: number) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = VERSION;
  buf[3] = p.type;
  buf[4] = 0;
  buf[5] = ttl;
  buf[6] = hops;
  buf[7] = 0;
  buf.set(p.msgId, 8);
  buf.set(p.src, 24);
  buf.set(p.dst, 56);
  view.setBigUint64(88, BigInt(p.timestamp));
  view.setUint16(96, p.payload.length);
}

/** Decode without verifying the signature. Throws PacketError on malformed input. */
export function decodePacket(bytes: Uint8Array): Packet {
  if (bytes.length < HEADER_BYTES + SIGNATURE_BYTES) throw new PacketError("too short");
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) throw new PacketError("bad magic");
  if (bytes[2] !== VERSION) throw new PacketError(`unsupported version ${bytes[2]}`);
  const type = bytes[3];
  if (type !== PacketType.Data && type !== PacketType.Receipt) throw new PacketError(`unknown type ${type}`);
  if (bytes[4] !== 0 || bytes[7] !== 0) throw new PacketError("reserved bits set");
  const ttl = bytes[5]!;
  if (ttl > MAX_TTL) throw new PacketError("ttl too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLen = view.getUint16(96);
  if (payloadLen > MAX_PAYLOAD) throw new PacketError("payload too large");
  if (bytes.length !== HEADER_BYTES + payloadLen + SIGNATURE_BYTES) throw new PacketError("length mismatch");
  const timestamp = Number(view.getBigUint64(88));
  if (!Number.isSafeInteger(timestamp)) throw new PacketError("bad timestamp");
  return {
    type,
    ttl,
    hops: bytes[6]!,
    msgId: bytes.slice(8, 24),
    src: bytes.slice(24, 56),
    dst: bytes.slice(56, 88),
    timestamp,
    payload: bytes.slice(HEADER_BYTES, HEADER_BYTES + payloadLen),
    signature: bytes.slice(HEADER_BYTES + payloadLen),
  };
}

export function verifyPacket(p: Packet): boolean {
  return verifySignature(p.src, signedBytes(p), p.signature);
}

export function isBroadcast(dst: Uint8Array): boolean {
  return dst.every((b) => b === 0);
}

export function msgIdHex(p: Packet): string {
  return toHex(p.msgId);
}

/** A copy one hop further along. */
export function forwarded(p: Packet): Packet {
  return { ...p, ttl: p.ttl - 1, hops: Math.min(p.hops + 1, 255) };
}
