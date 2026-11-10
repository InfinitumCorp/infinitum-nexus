/**
 * Products that may receive a Cumulus://ID sign-in code.
 *
 * One list for id.cumuluscloud.app and the mail.cumuluscloud.app alias. A redirect is accepted
 * when its origin is listed here: the button sends the person back to whatever page they were on,
 * so the path is not fixed. Fixed OIDC callbacks (Fabric and CNDCTR use /api/auth/callback) sit
 * on these same origins.
 *
 * Nothing is removed from the list Mail already shipped. New origins are added beside the old ones,
 * so a button that already points at mail.cumuluscloud.app still names a client we accept.
 */

export interface IdClient {
  name: string;
  /** CID app id the profile:read grant is recorded under. */
  app: string;
  origins: string[];
}

export const ID_CLIENTS: Record<string, IdClient> = {
  infinitum: {
    name: "Infinitum Corporation",
    app: "cumulus",
    origins: ["https://infinitumcorporation.ai", "https://www.infinitumcorporation.ai", "https://downloads.infinitumcorporation.ai"],
  },
  "cumulus-cloud": {
    name: "Cumulus://Cloud",
    app: "cumulus",
    origins: [
      "https://drive.cumuluscloud.app",
      "https://cloud.cumuluscloud.app",
      "https://cumuluscloud.app",
      "https://www.cumuluscloud.app",
      // Kept so an older button whose client is cumulus-cloud can still return to Mail.
      "https://mail.cumuluscloud.app",
      "https://ru.mail.cumuluscloud.app",
    ],
  },
  "cumulus-mail": {
    name: "Cumulus://Mail",
    app: "cumulus-mail",
    origins: ["https://mail.cumuluscloud.app", "https://ru.mail.cumuluscloud.app"],
  },
  scalvs: {
    name: "SCALVS.ai",
    app: "scalvs",
    origins: ["https://scalvs.app", "https://www.scalvs.app", "https://ru.scalvs.app"],
  },
  metatron: {
    name: "METATRON¹⁰⁰",
    app: "metatron",
    origins: ["https://mttrn.app", "https://www.mttrn.app"],
  },
  architect: {
    name: ":\\ARCHITECT\\",
    app: "architect",
    origins: ["https://rchtch.app", "https://www.rchtch.app"],
  },
  veil: {
    name: "VEIL</>",
    app: "veil",
    origins: ["https://infinitumveil.app", "https://www.infinitumveil.app"],
  },
  "veil-vpn": {
    name: "VEIL</> VPN",
    app: "veil",
    origins: ["https://infinitumveilvpn.app", "https://www.infinitumveilvpn.app"],
  },
  fabric: {
    name: "FabriC++",
    app: "fabric",
    origins: ["https://infinitumfabric.app", "https://www.infinitumfabric.app"],
  },
  "firm-wallet": {
    name: "$FIRM Wallet",
    app: "firm-wallet",
    origins: ["https://firmwallet.app", "https://www.firmwallet.app"],
  },
  firmament: {
    name: "$Firmament Network",
    app: "firmament",
    origins: ["https://firmnetwork.app", "https://www.firmnetwork.app"],
  },
  // Grants are stored under architect: "cndctr" is a legacy app id for that product.
  cndctr: {
    name: "CNDCTR",
    app: "cndctr",
    origins: ["https://cndctr.app", "https://www.cndctr.app"],
  },
  defense: {
    name: "Infinitum Defense",
    app: "cumulus",
    origins: ["https://infinitumdefense.com", "https://www.infinitumdefense.com"],
  },
  spectre: {
    name: "+SPCTR",
    app: "spectre",
    origins: ["https://spectre.infinitumcorporation.ai"],
  },
  // developer.infinitumcorporation.ai: where Infinitum developers sign in.
  developer: {
    name: "Infinitum Developer",
    app: "cumulus",
    origins: ["https://developer.infinitumcorporation.ai"],
  },
};

/** The client a redirect may go to, or null when it isn't one of ours. */
export function idClientFor(clientId: string, redirectUri: string): IdClient | null {
  const client = Object.prototype.hasOwnProperty.call(ID_CLIENTS, clientId) ? ID_CLIENTS[clientId]! : null;
  if (!client) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
  return client.origins.includes(url.origin) ? client : null;
}

/** Every origin that may call the token endpoints from a browser. */
export function idClientOrigins(): ReadonlySet<string> {
  return new Set(Object.values(ID_CLIENTS).flatMap((c) => c.origins));
}
