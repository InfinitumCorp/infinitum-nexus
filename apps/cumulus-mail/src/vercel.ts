import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger, signerFromPrivateKey } from "@infinitum/firmament";
import { cidSecretKeyForHost, socialFromEnv, upstreamIssuerFromEnv } from "@infinitum/cid";
import { createCumulus, emptyCumulusStores } from "@infinitum/cumulus";
import { RemoteState, HttpGateway } from "../../spectre/src/server/remote.ts";
import { cidStorageFromEnv, suiteDocuments } from "../../spectre/src/server/cid-store.ts";
import type { InboundMail } from "@infinitum/mail";
import { createMailApp } from "./app.ts";
import { deliverOutbound, type Sender } from "./outbound.ts";
import type { FileStore } from "./files.ts";
import { WorkspaceStore } from "./workspace.ts";
import { BillingLinkStore } from "@infinitum/billing";

/** Attachment storage, set by the Workers entry (R2) before the first request. */
let fileStore: FileStore | undefined;
export function useFileStore(store: FileStore) {
  fileStore = store;
}

/**
 * Cumulus://Mail on Vercel (serverless). Same state as every hosted Infinitum product: it lives in
 * Supabase behind the private nexus-store function, and each request loads the latest state and
 * saves atomically. An account made in any hosted product has this mailbox.
 *
 * Required environment variables:
 *   MAIL_ORIGIN            public URL, e.g. https://mail.cumuluscloud.app (passkeys are bound to its host)
 *   MAIL_EXTRA_ORIGINS     optional, comma-separated mirrors of the same app under the MAIL_ORIGIN host,
 *                          e.g. https://ru.mail.cumuluscloud.app (served through CloudFront for networks
 *                          that throttle Cloudflare); passkeys work on them because they share its rpId
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

/** Parses MAIL_EXTRA_ORIGINS. Each mirror must be a subdomain of the rpId host, or its passkeys would not work. */
export function extraOrigins(value: string | undefined, rpId: string): string[] {
  return (value ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .map((o) => {
      const host = new URL(o).hostname;
      if (!host.endsWith(`.${rpId}`)) throw new Error(`MAIL_EXTRA_ORIGINS: ${o} is not under ${rpId}`);
      return o;
    });
}

function build() {
  const origin = required("MAIL_ORIGIN").replace(/\/$/, "");
  const origins = [origin, ...extraOrigins(process.env.MAIL_EXTRA_ORIGINS, new URL(origin).hostname)];
  const signer = signerFromPrivateKey(required("FIRMAMENT_SIGNER_KEY"));
  const stores = emptyCumulusStores();
  const workspaceStore = new WorkspaceStore(); // Cumulus://Drive, Dox, Spreads and Podium (metadata; contents in R2)
  const billingStore = new BillingLinkStore(); // CID -> billing org (holds org API keys; server-side only)
  // CUMULUS_STORE=postgres keeps Cumulus://ID in Postgres rows (see spectre/src/server/cid-store.ts).
  const gateway = new HttpGateway(required("NEXUS_STORE_URL"), required("NEXUS_STORE_KEY"));
  const cidStorage = cidStorageFromEnv(process.env, gateway);
  // CUMULUS_ROWS=mail,wallet,quota keeps those as rows too, so their documents aren't loaded or saved.
  const state = new RemoteState(gateway, {
    ...suiteDocuments(cidStorage, stores),
    "cumulus-workspace": workspaceStore,
    "cumulus-billing": billingStore,
  });
  if (cidStorage.participant) state.participants.push(cidStorage.participant);
  if (cidStorage.rows) state.rows = cidStorage.rows;
  const ledger = new Ledger(state.ledgerStore, { authorizedSigners: [signer.publicKey] });
  const suite = createCumulus({
    ledger, signer, rpId: new URL(origin).hostname, origins, stores, repository: cidStorage.repository, repositories: cidStorage.repositories, secretKey: cidSecretKeyForHost(),
    social: { providers: socialFromEnv() }, mailOrigin: origin, upstreamIssuer: upstreamIssuerFromEnv(process.env),
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
    files: fileStore,
    workspaceStore,
    billingStore,
    publicDir: publicDir(), // static files come from the CDN (Vercel) or static assets (Workers)
    origin,
    secureCookies: origin.startsWith("https://"),
    noTimers: true,
    transaction: async (fn) => {
      await verifyOnce();
      return state.transaction(async () => {
        // Schedule send, without a timer. A database error isn't swallowed: the request's transaction
        // is gone with it (and a deadlock re-runs the request).
        await suite.mail.sendAllDue().catch((err) => {
          if ((err as { code?: unknown } | null)?.code) throw err;
          return 0;
        });
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
  // For the cron trigger: send queued mail to outside addresses.
  const sendOutbound = async (send: Sender) => {
    await verifyOnce();
    return deliverOutbound((fn) => state.transaction(fn), suite.mail, send);
  };
  return Object.assign(app, { sendDueNow: sendDue, receive, sendOutbound });
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

/** Sends queued mail to addresses outside Cumulus. Called by the Workers cron trigger. */
export async function deliverOutboundMail(send: Sender): Promise<number> {
  app ??= build();
  return app.sendOutbound(send);
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
