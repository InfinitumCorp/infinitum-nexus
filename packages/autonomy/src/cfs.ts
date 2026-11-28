/**
 * CCSDS primary header laid out by NASA cFE's CFE_MSG_CMD_HDR_INIT
 * (third_party/nasa-cfe/default_cfe_msg_hdr_pri.h).
 * Sequence flags are 0xC0, the unsegmented stand-alone packet.
 */
export function cfsPrimaryHeader(messageId: number, packetBytes: number): Uint8Array {
  if (!Number.isInteger(messageId) || messageId < 0 || messageId > 0xffff) {
    throw new Error("cFS message id is 16 bits");
  }
  if (!Number.isInteger(packetBytes) || packetBytes < 7 || packetBytes > 0xffff + 7) {
    throw new Error("cFS packet length");
  }
  const length = packetBytes - 7;
  return Uint8Array.of(
    (messageId >> 8) & 0xff,
    messageId & 0xff,
    0xc0,
    0x00,
    (length >> 8) & 0xff,
    length & 0xff,
  );
}
