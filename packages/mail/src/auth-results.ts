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
  return verdict(parsed.results);
}

/** `failWins`: any dmarc=fail decides, so an added dmarc=pass can never cancel one. */
function verdict(results: ParsedAuthResults["results"], failWins = false): InboundAuth {
  const of = (method: string) => results.filter((r) => r.method === method);
  const dmarc = of("dmarc");
  const failed = failWins ? dmarc.find((r) => r.result === "fail") : undefined;
  const decisive = failed ?? dmarc[0];
  const policyRaw = (decisive?.props["policy.dmarc"] ?? decisive?.props["policy.published-domain-policy"] ?? "").toLowerCase();
  const fromDomain = decisive?.props["header.from"]?.toLowerCase();
  return {
    verified: true,
    spf: asResult(best(of("spf").map((r) => r.result))),
    dkim: asResult(best(of("dkim").map((r) => r.result))),
    dmarc: failed ? "fail" : asResult(best(dmarc.map((r) => r.result))),
    dmarcPolicy: policyRaw === "none" || policyRaw === "quarantine" || policyRaw === "reject" ? policyRaw : undefined,
    fromDomain: fromDomain && /^[a-z0-9.-]{1,253}$/.test(fromDomain) ? fromDomain : undefined,
  };
}

/**
 * The verdict for mail checked on our own MTA (Postfix with OpenDKIM, OpenDMARC and an SPF check),
 * where each milter writes its own Authentication-Results, usually just below the Received line
 * Postfix adds. Only our hop is read: from the top down to the next Received (the hop before ours),
 * and only headers naming `trusted`. Their results are merged, and any dmarc=fail there refuses the
 * message even if another header says pass.
 *
 * A sender that connects straight to our MX can still write headers inside our hop. That can only
 * make the DMARC verdict worse, never better, but it could mark spf/dkim as passed for display.
 * So Postfix must drop incoming Authentication-Results that name our id before the milters run
 * (header_checks IGNORE; see the cumulus-mail README, "Node mode with Postfix").
 */
export function inboundAuthFromMta(headers: { key: string; value: string }[], trusted: string): InboundAuth {
  const id = trusted.toLowerCase();
  const results: ParsedAuthResults["results"] = [];
  let received = 0;
  let seen = false;
  for (const h of headers) {
    const key = h.key.toLowerCase();
    if (key === "received" && ++received > 1) break;
    if (key !== "authentication-results") continue;
    const parsed = parseAuthenticationResults(h.value);
    if (!parsed || parsed.authservId !== id) continue;
    results.push(...parsed.results);
    seen = true;
  }
  return seen ? verdict(results, true) : { verified: false };
}

/** Why a message must be refused, or null to deliver it. */
export function refuseReason(auth: InboundAuth | undefined): string | null {
  if (auth?.verified && auth.dmarc === "fail") {
    return "This message failed the sender domain's DMARC check, so it can't be delivered.";
  }
  return null;
}
