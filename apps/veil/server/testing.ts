import { CidService } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createVeilControl, type VeilControl } from "./control.ts";

export const VEIL_BRIDGES = [
  "bridge obfs4 192.0.2.10:443 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA cert=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa iat-mode=0",
];

export async function veilFixture(bridges: string[] = VEIL_BRIDGES) {
  let now = new Date("2026-11-07T12:00:00Z");
  const entitled = new Set<string>();
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({
    ledger,
    signer,
    rpId: "localhost",
    origins: ["http://localhost"],
    clock: () => now,
  });
  const control: VeilControl = createVeilControl({
    cid,
    bridges,
    entitled: (account) => entitled.has(account),
  });
  let count = 0;
  async function login(plan = false) {
    const account = await cid.createAccount({ username: `veil${++count}user` });
    const device = new VirtualAuthenticator();
    const registration = cid.startAuthenticatorRegistration(account.cid, "passkey");
    const key = await cid.finishAuthenticatorRegistration(
      account.cid,
      device.create({ challenge: registration.challenge, rpId: "localhost", origin: "http://localhost" }),
      { kind: "passkey" },
    );
    const challenge = cid.startSignIn();
    const result = await cid.finishSignIn(
      device.get({ credentialId: key.credentialId, challenge: challenge.challenge, origin: "http://localhost" }),
      "veil-test",
    );
    if (result.status !== "ok") throw new Error("Unexpected MFA");
    if (plan) entitled.add(account.cid);
    return { account, token: result.token, session: result.session };
  }
  return {
    cid,
    control,
    entitled,
    login,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
