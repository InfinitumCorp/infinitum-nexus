/**
 * Loopback Keycloak stand-in for tests. Not used by the server process.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const USERNAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

interface PendingCode {
  username: string;
  sub: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  nonce: string;
  exp: number;
}

export interface TestIdp {
  issuer: string;
  close(): Promise<void>;
  token(username: string, claims?: Record<string, unknown>): string;
}

export function startTestIdp(port: number, clientId: string): Promise<TestIdp> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const codes = new Map<string, PendingCode>();

  let issuer = "";
  const server = createServer((req, res) => {
    void handle(req, res, { issuer, clientId, privateKey, jwk, codes }).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("error");
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      const actual = address && typeof address === "object" ? address.port : port;
      issuer = `http://127.0.0.1:${actual}/realms/cumulus`;
      resolve({
        issuer,
        token(username, claims = {}) {
          return signToken(privateKey, {
            iss: issuer,
            sub: subFor(username),
            aud: clientId,
            azp: clientId,
            exp: Math.floor(Date.now() / 1000) + 3600,
            iat: Math.floor(Date.now() / 1000),
            preferred_username: username,
            email: `${username}@cumuluscloud.app`,
            name: username,
            ...claims,
          });
        },
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    issuer: string;
    clientId: string;
    privateKey: KeyObject;
    jwk: Record<string, unknown>;
    codes: Map<string, PendingCode>;
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const issuer = ctx.issuer;
  if (req.method === "GET" && url.pathname === "/realms/cumulus/protocol/openid-connect/certs") {
    return json(res, 200, { keys: [ctx.jwk] });
  }
  if (req.method === "GET" && url.pathname === "/realms/cumulus/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer,
      authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
      token_endpoint: `${issuer}/protocol/openid-connect/token`,
      jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    });
  }
  if (url.pathname === "/realms/cumulus/protocol/openid-connect/auth" && (req.method === "GET" || req.method === "POST")) {
    const username = req.method === "POST" ? new URLSearchParams(await readBody(req)).get("username") : url.searchParams.get("login_hint");
    if (!username) return html(res);
    const issued = issueCode(url.searchParams, username.toLowerCase(), ctx.clientId, ctx.codes);
    if ("error" in issued) return json(res, 400, issued);
    const redirect = new URL(issued.redirectUri);
    redirect.searchParams.set("code", issued.code);
    redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: redirect.href });
    res.end();
    return;
  }
  if (req.method === "POST" && url.pathname === "/realms/cumulus/protocol/openid-connect/token") {
    const form = new URLSearchParams(await readBody(req));
    const pending = ctx.codes.get(form.get("code") ?? "");
    ctx.codes.delete(form.get("code") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (!pending || pending.exp < Date.now() || pending.clientId !== form.get("client_id") || pending.redirectUri !== form.get("redirect_uri") || pending.challenge !== challenge || form.get("grant_type") !== "authorization_code") {
      return json(res, 400, { error: "invalid_grant" });
    }
    const idToken = signToken(ctx.privateKey, {
      iss: issuer,
      sub: pending.sub,
      aud: pending.clientId,
      azp: pending.clientId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      nonce: pending.nonce,
      preferred_username: pending.username,
      email: `${pending.username}@cumuluscloud.app`,
      name: pending.username,
    });
    return json(res, 200, { access_token: idToken, id_token: idToken, token_type: "Bearer", expires_in: 3600 });
  }
  json(res, 404, { error: "not found" });
}

function issueCode(query: URLSearchParams, username: string, clientId: string, codes: Map<string, PendingCode>): { code: string; redirectUri: string } | { error: string } {
  const redirectUri = query.get("redirect_uri");
  const challenge = query.get("code_challenge");
  const nonce = query.get("nonce");
  if (query.get("client_id") !== clientId || query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" || !redirectUri || !challenge || !nonce) {
    return { error: "invalid_request" };
  }
  let target: URL;
  try {
    target = new URL(redirectUri);
  } catch {
    return { error: "invalid_request" };
  }
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") return { error: "invalid_request" };
  if (!USERNAME.test(username)) return { error: "invalid_username" };
  const code = randomBytes(24).toString("base64url");
  codes.set(code, {
    username,
    sub: subFor(username),
    challenge,
    redirectUri,
    clientId,
    nonce,
    exp: Date.now() + 60_000,
  });
  return { code, redirectUri };
}

function signToken(privateKey: KeyObject, claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const data = Buffer.from(`${header}.${payload}`);
  const signature = sign("sha256", data, privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function subFor(username: string): string {
  const hash = createHash("sha256").update(`fabric-test-user:${username}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  res.end(payload);
}

function html(res: ServerResponse): void {
  const body = `<!doctype html><meta charset="utf-8"><title>Cumulus ID</title><form method="post"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><button type="submit">Continue</button></form>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16_384) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
