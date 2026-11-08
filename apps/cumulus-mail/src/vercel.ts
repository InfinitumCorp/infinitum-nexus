import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger, signerFromPrivateKey } from "@infinitum/firmament";
import { socialFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores } from "@infinitum/cumulus";
import { RemoteState, HttpGateway } from "../../spectre/src/server/remote.ts";
import type { InboundMail } from "@infinitum/mail";
import { createMailApp } from "./app.ts";

/**
 * Cumulus://Mail on Vercel (serverless). Same state as every hosted Infinitum product: it lives in
 * Supabase behind the private nexus-store function, and each request loads the latest state and
 * saves atomically. An account made in any hosted product has this mailbox.
 *
 * Required environment variables:
 *   MAIL_ORIGIN            public URL, e.g. https://mail.cumuluscloud.app (passkeys are bound to its host)
 *   FIRMAMENT_SIGNER_KEY   base64 PKCS#8 Ed25519 key that signs ledger entries (keep secret)
 *   NEXUS_STORE_URL        https://<project>.supabase.co/functions/v1/nexus-store
 *   NEXUS_STORE_KEY        gateway key; its SHA-256 is listed in nexus_gateway_keys
 * Optional: XAI_API_KEY (SCALVS), ANTHROPIC_API_KEY (SCALVS Clean), social sign-in variables.
 *
 * Hosted mode seals mail in transit (Cumulus Tunnel) but has no at-rest master key, and serverless
 * functions keep no timers, so scheduled mail is sent the next time anyone uses Mail.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** Workers give modules a non-URL import.meta.url, so fall back to a fixed path there. */
function publicDir(): string {
  try {
    return new URL("./public/", import.meta.url).pathname;
  } catch {
    return "/public/";
  }
}

function build() {
  const origin = required("MAIL_ORIGIN").replace(/\/$/, "");
  const signer = signerFromPrivateKey(required("FIRMAMENT_SIGNER_KEY"));
  const stores = emptyCumulusStores();
  const state = new RemoteState(new HttpGateway(required("NEXUS_STORE_URL"), required("NEXUS_STORE_KEY")), {
    cid: stores.cid,
    "cumulus-mail": stores.mail,
    "firm-wallet": stores.wallet,
    "cumulus-quota": stores.quota,
    "cumulus-suite": stores.suite,
  });
  const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
  const suite = createCumulus({
    ledger, signer, rpId: new URL(origin).hostname, origins: [origin], stores,
    social: { providers: socialFromEnv() }, mailOrigin: origin,
  });

  // Refuse to serve if the stored ledger fails verification (tampering or a wrong signing key).
  let verified: Promise<void> | undefined;
  const verifyOnce = () =>
    (verified ??= (async () => {
      await state.sync();
      const result = await ledger.verify();
      if (!result.ok) throw new Error(`Firmament ledger failed verification at entry ${result.brokenAt}: ${result.reason}`);
    })().catch((err) => {
      verified = undefined;
      throw err;
    }));

  let app: ReturnType<typeof createMailApp>;
  app = createMailApp({
    suite,
    publicDir: publicDir(), // static files come from the CDN (Vercel) or static assets (Workers)
    origin,
    secureCookies: origin.startsWith("https://"),
    noTimers: true,
    transaction: async (fn) => {
      await verifyOnce();
      return state.transaction(async () => {
        await suite.mail.sendAllDue().catch(() => 0); // Schedule send, without a timer
        return fn();
      });
    },
  });
  // For a cron trigger: send scheduled mail that is due, without waiting for a request.
  const sendDue = async () => {
    await verifyOnce();
    return state.transaction(() => suite.mail.sendAllDue());
  };
  // For Email Routing: deliver mail that arrived from outside Cumulus.
  const receive = async (mail: InboundMail) => {
    await verifyOnce();
    return state.transaction(async () => suite.mail.receive(mail));
  };
  return Object.assign(app, { sendDueNow: sendDue, receive });
}

let app: ReturnType<typeof build> | undefined;

/** Delivers mail from outside Cumulus. Called by the Workers email() handler (Email Routing). */
export async function receiveMail(mail: InboundMail) {
  app ??= build();
  return app.receive(mail);
}

/** Sends scheduled mail that is due. Called by the Workers cron trigger. */
export async function sendScheduledMail(): Promise<number> {
  app ??= build();
  return app.sendDueNow();
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    app ??= build();
  } catch (err) {
    console.error(err);
    res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Cumulus://Mail isn't configured yet. Please try again later." }));
    return;
  }
  await app.handle(req, res);
}
