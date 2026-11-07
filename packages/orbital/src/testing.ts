import { CidService } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidLabyrinth, MemoryStorage } from "@infinitum/lbrnth";
import type { LabyrinthStorage } from "@infinitum/lbrnth";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
export async function setup(storage: LabyrinthStorage = new MemoryStorage()) {
  let now = new Date("2026-11-07T04:27:00Z"),
    paid = true;
  const signer = generateSigner(),
    ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({
    ledger,
    signer,
    rpId: "localhost",
    origins: ["http://localhost"],
    clock: () => now,
  });
  const options = { storage, entitled: () => paid, clock: () => now };
  const auth = new CidLabyrinth(cid, options);
  let count = 0;
  async function login() {
    const account = await cid.createAccount({ username: `orbital-${++count}` });
    await cid.createOrganization("Orbital planning client", account.cid);
    const device = new VirtualAuthenticator(),
      registration = cid.startAuthenticatorRegistration(account.cid, "passkey");
    const key = await cid.finishAuthenticatorRegistration(
      account.cid,
      device.create({
        challenge: registration.challenge,
        rpId: "localhost",
        origin: "http://localhost",
      }),
      { kind: "passkey" },
    );
    const challenge = cid.startSignIn();
    const result = await cid.finishSignIn(
      device.get({
        credentialId: key.credentialId,
        challenge: challenge.challenge,
        origin: "http://localhost",
      }),
      "test",
    );
    if (result.status !== "ok") throw new Error("Unexpected MFA");
    await cid.grant(account.cid, "LBRNTH", [
      "repo:read",
      "repo:write",
      "repo:admin",
    ]);
    auth.provision(result.token);
    return {
      account,
      token: result.token,
      session: result.session,
      repo: auth.forSession(result.token).createRepository("offline-orbits").id,
    };
  }
  const owner = await login();
  return {
    owner,
    cid,
    auth,
    options,
    login,
    setPaid: (value: boolean) => {
      paid = value;
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    expire: () => {
      now = new Date(now.getTime() + 31 * 86400000);
    },
  };
}
