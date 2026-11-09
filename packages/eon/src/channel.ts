/**
 * E(O)N secure channel.
 * Voice and text frames are sealed with AES-256-GCM. The nonce is a 96-bit
 * frame counter, so a key never reuses a nonce, and the receiver rejects any
 * frame whose counter is not newer than the last one it accepted (replay and
 * reordering protection). The frame kind and link id are bound as AAD.
 */
import { createCipheriv, createDecipheriv } from "node:crypto";
import type { PairingKeys } from "./pairing.ts";

export type FrameKind = "voice" | "text" | "control";

export interface EonFrame {
  linkId: string;
  kind: FrameKind;
  counter: number;
  /** base64(ciphertext || tag) */
  sealed: string;
}

const MAX_COUNTER = 2 ** 48;

function nonce(counter: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUIntBE(counter, 6, 6);
  return n;
}

function aad(linkId: string, kind: FrameKind, counter: number): Buffer {
  return Buffer.from(`${linkId}|${kind}|${counter}`, "utf8");
}

export class SecureChannel {
  private sendCounter = 0;
  private lastReceived = -1;
  private readonly keys: PairingKeys;

  constructor(keys: PairingKeys) {
    this.keys = keys;
  }

  seal(kind: FrameKind, payload: Uint8Array | string): EonFrame {
    if (this.sendCounter >= MAX_COUNTER) throw new Error("channel exhausted: re-pair to rotate keys");
    const counter = this.sendCounter++;
    const cipher = createCipheriv("aes-256-gcm", this.keys.sendKey, nonce(counter));
    cipher.setAAD(aad(this.keys.linkId, kind, counter));
    const data = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
    const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    return { linkId: this.keys.linkId, kind, counter, sealed: ct.toString("base64") };
  }

  open(frame: EonFrame): Buffer {
    if (frame.linkId !== this.keys.linkId) throw new Error("frame is for another link");
    if (!Number.isInteger(frame.counter) || frame.counter <= this.lastReceived) {
      throw new Error("replayed or out-of-order frame");
    }
    const buf = Buffer.from(frame.sealed, "base64");
    if (buf.length < 16) throw new Error("frame too short");
    const decipher = createDecipheriv("aes-256-gcm", this.keys.receiveKey, nonce(frame.counter));
    decipher.setAAD(aad(frame.linkId, frame.kind, frame.counter));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
    this.lastReceived = frame.counter;
    return pt;
  }

  openText(frame: EonFrame): string {
    return this.open(frame).toString("utf8");
  }
}
