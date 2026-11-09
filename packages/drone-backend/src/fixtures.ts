// Independent bit-at-a-time CRC oracle (production uses byte-wise recurrence).
export function crc(bytes: Uint8Array) {
  let value = 0xffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0x8408 : value >>> 1;
  }
  return value;
}
export function frame(id = 0, payload = Buffer.from("000000000203d10403", "hex"), v2 = false, flags = 0) {
  const header = v2 ? Buffer.from([0xfd, payload.length, flags, 0, 7, 1, 1, id, 0, 0]) : Buffer.from([0xfe, payload.length, 7, 1, 1, id]);
  const extra = ({0: 50, 1: 124, 33: 104} as Record<number, number>)[id] ?? 0;
  const checksum = crc(Buffer.concat([header.subarray(1), payload, Buffer.from([extra])]));
  return Buffer.concat([header, payload, Buffer.from([checksum & 255, checksum >>> 8])]);
}
