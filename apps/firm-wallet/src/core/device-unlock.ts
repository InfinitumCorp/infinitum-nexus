/**
 * Unlock with fingerprint, face or the phone's screen lock, using a passkey on this device and
 * the WebAuthn PRF extension (open web standard, no server, no fees).
 *
 * The authenticator (the phone's secure hardware) returns a 32-byte secret only after it has
 * verified the person. That secret, never stored, encrypts a second copy of the recovery phrase
 * (see vault.ts). Nothing about the passkey is sent anywhere; the password keeps working.
 */
import { deviceVaultIds, sealWithSecret, unsealWithSecret, VaultError, type DeviceVault } from "./vault.ts";

type PrfOutputs = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | ArrayBufferView } } };

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const bytes = (b: ArrayBuffer | ArrayBufferView) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/** True when this browser has a built-in authenticator that checks the person (fingerprint, face, PIN). */
export async function deviceUnlockAvailable(): Promise<boolean> {
  try {
    const PKC = globalThis.PublicKeyCredential as (typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean>> }) | undefined;
    if (!PKC || !window.isSecureContext) return false;
    if (PKC.getClientCapabilities) {
      const caps = await PKC.getClientCapabilities();
      if (caps["extension:prf"] === false) return false;
    }
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function friendly(e: unknown): Error {
  const name = (e as DOMException)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return new Error("Cancelled.");
  if (name === "InvalidStateError") return new Error("This device already has a passkey for this wallet. Turn device unlock off and on again.");
  if (name === "SecurityError") return new Error("Device unlock needs the wallet's secure address (https).");
  return e instanceof Error ? e : new Error(String(e));
}

async function prfSecret(credentialId: Uint8Array, prfSalt: Uint8Array): Promise<Uint8Array> {
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
        userVerification: "required",
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  const first = (cred.getClientExtensionResults() as PrfOutputs).prf?.results?.first;
  if (!first) throw new VaultError("This device's passkeys can't unlock a wallet. Keep using your password.");
  return bytes(first);
}

/** Creates a passkey on this device and seals a copy of the phrase under its secret. */
export async function enableDeviceUnlock(phrase: string): Promise<DeviceVault> {
  const prfSalt = random(32);
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: "$FIRM Wallet" },
        user: { id: random(16), name: "$FIRM Wallet", displayName: "$FIRM Wallet on this device" },
        challenge: random(32),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
        timeout: 60_000,
        extensions: { prf: { eval: { first: prfSalt as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    throw friendly(e);
  }
  const ext = cred.getClientExtensionResults() as PrfOutputs;
  if (ext.prf?.enabled === false || !ext.prf) throw new VaultError("This device's passkeys can't unlock a wallet. Keep using your password.");
  const credentialId = new Uint8Array(cred.rawId);
  // Some devices return the secret when the passkey is made; others need one more check.
  const secret = ext.prf.results?.first ? bytes(ext.prf.results.first) : await prfSecret(credentialId, prfSalt);
  return sealWithSecret(phrase, secret, credentialId, prfSalt);
}

export async function unlockWithDevice(v: DeviceVault): Promise<string> {
  const { credentialId, prfSalt } = deviceVaultIds(v);
  return unsealWithSecret(v, await prfSecret(credentialId, prfSalt));
}
