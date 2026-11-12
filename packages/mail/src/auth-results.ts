/**
 * Sender authentication for mail arriving from outside Cumulus.
 *
 * Cloudflare Email Routing checks SPF, DKIM and DMARC before it hands a message to the Worker and
 * prepends its own Authentication-Results header (RFC 8601) with the authentication service id
 * mx.cloudflare.net. Only that FIRST header can be trusted: any Authentication-Results further
 * down was written by the sender or a server along the way and says nothing reliable.
 *
 * Policy (deliberately conservative, so a format change at the edge never drops good mail):
 *   - Trusted header says dmarc=fail  -> refuse the message (the sender's domain says it isn't theirs).
 *   - Anything else                   -> deliver, and keep the verdict on the message.
 */

/** Authentication service id Cloudflare Email Routing writes. */
export const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

export type AuthResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy";

/** What the receiving edge reported about the sender. Stored on each delivered message. */
export interface InboundAuth {
  /** True when the verdict came from the trusted edge header; false means "not checked here". */
  verified: boolean;
  spf?: AuthResult;
  dkim?: AuthResult;
  dmarc?: AuthResult;
  /** The sender domain's published DMARC policy, when the edge reported it. */
  dmarcPolicy?: "none" | "quarantine" | "reject";
  /** RFC5322.From domain DMARC was evaluated for. */
  fromDomain?: string;
}

export interface ParsedAuthResults {
  authservId: string;
  results: { method: string; result: string; props: Record<string, string> }[];
}

const RESULTS = new Set<AuthResult>(["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy"]);

/** Remove RFC 5322 comments "( ... )", including nested ones, so they can't smuggle tokens. */
function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && depth > 0) { i++; continue; }
    if (c === "(") { depth++; continue; }
    if (c === ")" && depth > 0) { depth--; continue; }
    if (depth === 0) out += c;
  }
  return out;
}

/** Parse one Authentication-Results header value. Returns null when it isn't one. */
export function parseAuthenticationResults(value: string): ParsedAuthResults | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  const parts = stripComments(value).replace(/\s+/g, " ").split(";").map((p) => p.trim());
  const head = parts.shift() ?? "";
  // authserv-id [version]
  const authservId = head.split(" ")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9.-]+$/.test(authservId)) return null;
  const results: ParsedAuthResults["results"] = [];
  for (const part of parts) {
    if (!part || part.toLowerCase() === "none") continue;
    const tokens = part.split(" ").filter(Boolean);
    const first = /^([a-z0-9_-]+)(?:\/[0-9]+)?=([a-z0-9_-]+)$/i.exec(tokens[0] ?? "");
    if (!first) continue;
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const kv = /^([a-z0-9_.-]+)=(.+)$/i.exec(t);
      if (kv) props[kv[1]!.toLowerCase()] = kv[2]!.replace(/^"|"$/g, "");
    }
    results.push({ method: first[1]!.toLowerCase(), result: first[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

const asResult = (r?: string): AuthResult | undefined => (r && RESULTS.has(r as AuthResult) ? (r as AuthResult) : undefined);

/** The strongest result among several of one method (e.g. a message with two DKIM signatures). */
function best(list: string[]): AuthResult | undefined {
  const order: AuthResult[] = ["pass", "fail", "softfail", "neutral", "policy", "temperror", "permerror", "none"];
  for (const r of order) if (list.includes(r)) return r;
  return undefined;
}

/**
 * The verdict for a message, from its headers in the order they appear (top first).
 * Only the first Authentication-Results header is read, and only if it is from `trusted`.
 */
export function inboundAuth(headers: { key: string; value: string }[], trusted = CLOUDFLARE_AUTHSERV_ID): InboundAuth {
  const first = headers.find((h) => h.key.toLowerCase() === "authentication-results");
  const parsed = first ? parseAuthenticationResults(first.value) : null;
  if (!parsed || parsed.authservId !== trusted.toLowerCase()) return { verified: false };
  const of = (method: string) => parsed.results.filter((r) => r.method === method);
  const dmarc = of("dmarc");
  const policyRaw = (dmarc[0]?.props["policy.dmarc"] ?? dmarc[0]?.props["policy.published-domain-policy"] ?? "").toLowerCase();
  const fromDomain = dmarc[0]?.props["header.from"]?.toLowerCase();
  return {
    verified: true,
    spf: asResult(best(of("spf").map((r) => r.result))),
    dkim: asResult(best(of("dkim").map((r) => r.result))),
    dmarc: asResult(best(dmarc.map((r) => r.result))),
    dmarcPolicy: policyRaw === "none" || policyRaw === "quarantine" || policyRaw === "reject" ? policyRaw : undefined,
    fromDomain: fromDomain && /^[a-z0-9.-]{1,253}$/.test(fromDomain) ? fromDomain : undefined,
  };
}

/** Why a message must be refused, or null to deliver it. */
export function refuseReason(auth: InboundAuth | undefined): string | null {
  if (auth?.verified && auth.dmarc === "fail") {
    return "This message failed the sender domain's DMARC check, so it can't be delivered.";
  }
  return null;
}
