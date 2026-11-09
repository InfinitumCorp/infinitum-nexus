import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { encodeCbor, type CborValue } from "../cbor.ts";
import type { RegistrationResponse, AssertionResponse } from "../webauthn.ts";

/**
 * A software authenticator that performs real WebAuthn cryptography, for tests and local
 * development (the same role as Chrome DevTools' virtual authenticator).
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

interface StoredCredential {
  id: Uint8Array;
  privateKey: KeyObject;
  alg: "ES256" | "EdDSA";
  rpId: string;
  counter: number;
}

export class VirtualAuthenticator {
  readonly credentials = new Map<string, StoredCredential>();
  readonly userVerifying: boolean;
  private readonly useCounter: boolean;

  /**
   * @param options.userVerifying  true = passkey with biometrics/PIN; false = plain security-key tap
   * @param options.useCounter     false mimics synced passkeys, which always report counter 0
   */
  constructor(options: { userVerifying?: boolean; useCounter?: boolean } = {}) {
    this.userVerifying = options.userVerifying ?? true;
    this.useCounter = options.useCounter ?? true;
  }

  private flags(attested: boolean) {
    return 0x01 | (this.userVerifying ? 0x04 : 0) | (attested ? 0x40 : 0);
  }

  create(opts: { challenge: string; origin: string; rpId: string; alg?: "ES256" | "EdDSA" }): RegistrationResponse {
    const alg = opts.alg ?? "ES256";
    const { privateKey, publicKey } =
      alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" });
    const x = new Uint8Array(Buffer.from(jwk.x as string, "base64url"));
    const cose =
      alg === "ES256"
        ? new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, new Uint8Array(Buffer.from(jwk.y as string, "base64url"))]])
        : new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, x]]);

    const id = randomBytes(16);
    const counter = this.useCounter ? 1 : 0;
    this.credentials.set(b64u(id), { id, privateKey, alg, rpId: opts.rpId, counter });

    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(opts.rpId), Buffer.from([this.flags(true)]), counterBytes,
      Buffer.alloc(16), idLen, id, Buffer.from(encodeCbor(cose)),
    ]);
    const clientData = { type: "webauthn.create", challenge: opts.challenge, origin: opts.origin, crossOrigin: false };
    return {
      clientDataJSON: b64u(Buffer.from(JSON.stringify(clientData))),
      attestationObject: b64u(encodeCbor(new Map<string, CborValue>([
        ["fmt", "none"], ["attStmt", new Map()], ["authData", new Uint8Array(authData)],
      ]))),
    };
  }

  get(opts: { credentialId: string; challenge: string; origin: string; rpIdOverride?: string; counterOverride?: number }): AssertionResponse {
    const cred = this.credentials.get(opts.credentialId);
    if (!cred) throw new Error("virtual authenticator: unknown credential");
    if (this.useCounter) cred.counter += 1;
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(opts.counterOverride ?? cred.counter);
    const authData = Buffer.concat([sha256(opts.rpIdOverride ?? cred.rpId), Buffer.from([this.flags(false)]), counterBytes]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
    const data = Buffer.concat([authData, sha256(clientDataJSON)]);
    const signature = cred.alg === "EdDSA"
      ? sign(null, data, cred.privateKey)
      : sign("sha256", data, { key: cred.privateKey, dsaEncoding: "ieee-p1363" });
    return {
      credentialId: opts.credentialId,
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authData),
      signature: b64u(signature),
    };
  }
}
