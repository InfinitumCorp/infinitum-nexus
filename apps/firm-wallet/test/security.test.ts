import { describe, expect, it } from "vitest";
import { sealWithSecret, unsealWithSecret, VaultError } from "../src/core/vault.ts";
import { gpcEnabled, offeredProducts, sharingAllowed } from "../src/core/data-sharing.ts";

const PHRASE = "test test test test test test test test test test test junk";

describe("device unlock vault (passkey PRF secret)", () => {
  const secret = new Uint8Array(32).fill(7);
  const cred = new Uint8Array([1, 2, 3, 4]);
  const salt = new Uint8Array(32).fill(9);

  it("opens only with the same authenticator secret", async () => {
    const v = await sealWithSecret(PHRASE, secret, cred, salt);
    expect(v.data).not.toContain("test");
    expect(await unsealWithSecret(v, secret)).toBe(PHRASE);
    await expect(unsealWithSecret(v, new Uint8Array(32).fill(8))).rejects.toBeInstanceOf(VaultError);
  });

  it("binds the secret to the salt it was asked for", async () => {
    const v = await sealWithSecret(PHRASE, secret, cred, salt);
    await expect(unsealWithSecret({ ...v, prfSalt: btoa("x".repeat(32)) }, secret)).rejects.toBeInstanceOf(VaultError);
  });

  it("refuses a short secret", async () => {
    await expect(sealWithSecret(PHRASE, new Uint8Array(16), cred, salt)).rejects.toThrow(/usable secret/);
  });
});

describe("data exchange opt-in", () => {
  it("shares only on an explicit yes, never with Global Privacy Control", () => {
    expect(sharingAllowed({ veil: true }, "veil", false)).toBe(true);
    expect(sharingAllowed({ veil: true }, "veil", true)).toBe(false);
    expect(sharingAllowed({}, "veil", false)).toBe(false);
    expect(sharingAllowed({ veil: false }, "veil", false)).toBe(false);
  });

  it("never offers military editions, the network or the corporate site", () => {
    expect(sharingAllowed({ odin: true }, "odin", false)).toBe(false);
    expect(offeredProducts([{ id: "veil" }, { id: "odin" }, { id: "aether-mil" }, { id: "firmament" }, { id: "infinitum" }]).map((p) => p.id)).toEqual(["veil"]);
  });

  it("reads Global Privacy Control from the browser", () => {
    expect(gpcEnabled({ globalPrivacyControl: true })).toBe(true);
    expect(gpcEnabled({})).toBe(false);
  });
});
