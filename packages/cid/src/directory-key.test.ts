import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, CidStore, isPublicKeyArmor } from "./index.ts";

const PUB = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nxsBNB\n-----END PGP PUBLIC KEY BLOCK-----\n";
const PRIV = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nsecret\n-----END PGP PRIVATE KEY BLOCK-----\n";

function service(store = new CidStore()) {
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  return new CidService({ ledger, signer, rpId: "id.cumuluscloud.app", origins: ["https://id.cumuluscloud.app"], store });
}

describe("Cumulus://ID public key directory", () => {
  it("publishes only a public key for a verified address and keeps it on the account", async () => {
    const cid = service();
    const account = await cid.createAccount({ username: "ada" });
    assert.equal(await cid.publishDirectoryKey(account.cid, "ADA@cumuluscloud.app", PUB), "ok");
    assert.equal(await cid.lookupDirectoryKey("ada@cumuluscloud.app"), PUB.trim());
    assert.equal(await cid.publishDirectoryKey(account.cid, "other@example.com", PUB), "forbidden");
    assert.equal(await cid.publishDirectoryKey(account.cid, account.mailAddress, PRIV), "invalid");
    assert.equal(isPublicKeyArmor(PRIV), false);
    assert.equal((await cid.getAccount(account.cid)).directoryKey?.armored.includes("PRIVATE"), false);

    const snap = JSON.parse(JSON.stringify(Object.fromEntries(
      Object.entries(cid.store).map(([k, v]) => [k, v instanceof Map ? { __map: [...v.entries()] } : v]),
    ))) as Record<string, { __map?: [string, unknown][] }>;
    const restored = new CidStore();
    for (const [k, v] of Object.entries(snap)) {
      const map = (restored as unknown as Record<string, unknown>)[k];
      if (map instanceof Map && Array.isArray(v.__map)) for (const [mk, mv] of v.__map) map.set(mk, mv);
    }
    const again = service(restored);
    assert.equal(await again.lookupDirectoryKey("ada@cumuluscloud.app"), PUB.trim());
  });

  it("does not let one account replace another's key", async () => {
    const cid = service();
    const ada = await cid.createAccount({ username: "ada" });
    const bea = await cid.createAccount({ username: "bea" });
    assert.equal(await cid.publishDirectoryKey(ada.cid, ada.mailAddress, PUB), "ok");
    assert.equal(await cid.publishDirectoryKey(bea.cid, ada.mailAddress, PUB), "forbidden");
    assert.equal(await cid.lookupDirectoryKey(ada.mailAddress), PUB.trim());
  });
});
