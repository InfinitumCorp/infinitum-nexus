/**
 * FABRIC++ client used by the end-to-end test.
 * It follows the same sign-in, session, send, and receive calls as the web page.
 */

export interface FabricProfile {
  sub: string;
  username: string;
  email: string | null;
  name: string | null;
}

export interface FabricSessionSummary {
  id: string;
  peer: { sub: string; username: string; name: string | null };
  createdAt: string;
  updatedAt: string;
  preview: string | null;
}

export interface FabricClientMessage {
  id: string;
  sessionId: string;
  sender: string;
  username: string;
  text: string;
  createdAt: string;
  unreadable: boolean;
}

export class FabricClient {
  private readonly origin: string;
  private readonly cookies = new Map<string, string>();

  constructor(base: string) {
    this.origin = new URL(base).origin;
  }

  async login(username: string): Promise<FabricProfile> {
    let current = new URL(`/api/auth/login?login_hint=${encodeURIComponent(username)}`, this.origin);
    let response = await this.send(current);
    for (let hop = 0; hop < 6 && response.status >= 300 && response.status < 400; hop += 1) {
      const location = response.headers.get("location");
      if (!location) break;
      current = new URL(location, current);
      response = await this.send(current);
    }
    return this.json<FabricProfile>(await this.send(new URL("/api/me", this.origin)));
  }

  async me(): Promise<FabricProfile> {
    return this.json<FabricProfile>(await this.send(new URL("/api/me", this.origin)));
  }

  async sessions(): Promise<FabricSessionSummary[]> {
    const body = await this.json<{ sessions: FabricSessionSummary[] }>(await this.send(new URL("/api/sessions", this.origin)));
    return body.sessions;
  }

  async openSession(username: string): Promise<FabricSessionSummary> {
    return this.json<FabricSessionSummary>(await this.send(new URL("/api/sessions", this.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username }),
    }));
  }

  async sendMessage(sessionId: string, text: string): Promise<FabricClientMessage> {
    return this.json<FabricClientMessage>(await this.send(new URL(`/api/sessions/${sessionId}/messages`, this.origin), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }));
  }

  async receive(sessionId: string): Promise<FabricClientMessage[]> {
    const body = await this.json<{ messages: FabricClientMessage[] }>(await this.send(new URL(`/api/sessions/${sessionId}/messages`, this.origin)));
    return body.messages;
  }

  async logout(): Promise<void> {
    const response = await this.send(new URL("/api/auth/logout", this.origin), { method: "POST" });
    if (response.status !== 204) throw new Error(`logout failed: ${response.status}`);
  }

  /** Signed-in JSON call to any API path. Returns the parsed body, or null for 204. */
  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const response = await this.send(new URL(path, this.origin), init);
    if (response.status === 204) return null as T;
    return this.json<T>(response);
  }

  /** Signed-in raw request, for downloads and event streams. */
  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    return this.send(new URL(path, this.origin), init);
  }

  /** Call an API path with a raw bearer token and no session cookie. */
  static async bearer(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(new URL(path, base), { ...init, headers, redirect: "manual" });
  }

  private async send(url: URL, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (url.origin === this.origin) {
      const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
      if (cookie) headers.set("cookie", cookie);
      headers.set("origin", this.origin);
    }
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.origin === this.origin) this.absorb(response);
    return response;
  }

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const cleared = attrs.some((attr) => attr.trim().toLowerCase() === "max-age=0") || value === "";
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    const body = text ? JSON.parse(text) as { error?: string } : {};
    if (!response.ok) throw new Error(`${response.status} ${body.error ?? text}`);
    return body as T;
  }
}
