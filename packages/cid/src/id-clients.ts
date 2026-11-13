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
  /**
   * Internal tools that run on the person's own computer may return to http://127.0.0.1:<port> or
   * http://localhost:<port> (RFC 8252 loopback redirect). PKCE still binds the code to the tool.
   */
  loopback?: boolean;
}

export const ID_CLIENTS: Record<string, IdClient> = {
  infinitum: {
    name: "Infinitum Corporation",
    app: "cumulus",
    origins: [
      "https://infinitumcorporation.ai",
      "https://www.infinitumcorporation.ai",
      "https://downloads.infinitumcorporation.ai",
      // Russia copy on its own Yandex server; visitors in Russia are redirected there.
      "https://ru.infinitumcorporation.ai",
    ],
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
    origins: [
      "https://rchtch.app",
      "https://www.rchtch.app",
      // The :\ARCHITECT\ Chrome extension (chrome.identity.launchWebAuthFlow).
      "https://ldhkkbpfacheloapjlgnalmbaciameec.chromiumapp.org",
    ],
  },
  veil: {
    name: "VEIL</>",
    app: "veil",
    origins: ["https://infinitumveil.app", "https://www.infinitumveil.app"],
  },
  "veil-vpn": {
    name: "VEIL</> VPN",
    app: "veil",
    origins: [
      "https://infinitumveilvpn.app",
      "https://www.infinitumveilvpn.app",
      // Russia copy on its own Yandex server; visitors in Russia are redirected there.
      "https://ru.infinitumveilvpn.app",
    ],
  },
  fabric: {
    name: "FabriC++",
    app: "fabric",
    origins: [
      "https://infinitumfabric.app",
      "https://www.infinitumfabric.app",
      // Fabric Russia (Yandex Cloud, fabric-russia): Synapse signs in from here (InfinitumCorp/fabric-ru).
      "https://ru.infinitumfabric.app",
    ],
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
  "1mind": {
    name: "1MIND",
    app: "1mind",
    // 1MIND Russia (Yandex Cloud, conjure-russia). Internal: the server still checks CID_OWNERS.
    origins: ["https://1mind-ru.infinitumcorporation.ai"],
    loopback: true,
  },
  conjure: {
    name: "Conjure",
    app: "conjure",
    // Conjure Russia (Yandex Cloud). Public: any Cumulus ID signs in with its own account
    // (InfinitumCorp/Conjure#15); CID_OWNERS and listed staff are admins.
    // Plus its global hostname: a Cloudflare Worker forwarding to the same server, for networks that block Yandex Cloud.
    origins: ["https://conjure-ru.infinitumcorporation.ai", "https://conjure.infinitumcorporation.ai"],
    loopback: true,
  },
  "eidetic-admin": {
    name: "ei·det·ic purpose desk",
    app: "eidetic",
    origins: [],
    loopback: true,
  },
  "eidetic-reviewer": {
    name: "ei·det·ic review desk",
    app: "eidetic",
    origins: [],
    loopback: true,
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
  // Nøde: free community Wi-Fi (InfinitumCorp/node). A public product, so https only and no
  // loopback. Its access tokens carry aud "node", which the Nøde API checks.
  node: {
    name: "Nøde",
    app: "node",
    origins: ["https://node.infinitumcorporation.ai"],
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
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === "http:") return client.loopback && isLoopback(url) ? client : null;
  if (url.protocol !== "https:") return null;
  return client.origins.includes(url.origin) ? client : null;
}

/** http://127.0.0.1:<port> or http://localhost:<port>, with an explicit port. */
function isLoopback(url: URL): boolean {
  return (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") && url.port !== "";
}

/** Every origin that may call the token endpoints from a browser. */
export function idClientOrigins(): ReadonlySet<string> {
  return new Set(Object.values(ID_CLIENTS).flatMap((c) => c.origins));
}
