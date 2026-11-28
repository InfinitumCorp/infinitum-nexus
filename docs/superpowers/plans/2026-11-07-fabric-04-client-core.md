# FabriC++ client core (platform-free) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The rules the screens will use, as plain TypeScript with tests that run on Linux: fail-closed send rules, message status, log redaction, brand tokens, the revenue API client (entitlements, consent, earnings, payments switched off) and on-device usage counts with no identifiers.

**Architecture:** `app/src/core/*.ts` with no React Native or native imports, so Node's test runner can run it. The revenue client takes `fetch` and a token provider as parameters and is tested with a fake.

**Tech Stack:** TypeScript, Node 24 test runner with `--experimental-strip-types`.

## Global Constraints

- Sending is allowed only when the room is encrypted, its encryption state is known, and no identity change is waiting for acknowledgement.
- Undecryptable messages show no content.
- Logs never contain message bodies, tokens, passwords, keys or full Matrix user ids.
- Colours: paper `#ffffff`, ink `#111820`, muted `#52606b`, line `#d6dce1`, accent `#2454dd`. Font stack `'Helvetica Neue', Helvetica, Arial, sans-serif`, headings weight 400. Product name "FabriC++". No Infinitum logo.
- Monetization values from `infinitum-revenue` notes: contributor share 70%, hold 14 days, USD, tokens off. Personal free; Business 800 cents per seat per month, organisations only.
- Payments are off: no checkout, payout-account or payout calls while `paymentsEnabled` is `false`.
- Usage counts contain only numbers and a date: never content, contact, room, user or device identifiers.
- No import of `@infinitum/fabric`.

Location: `<app-repo>/app/src/core/` (index decision 1). Can be built before Stage 3 finishes.

---

### Task 1: Send rules and message status

**Files:**
- Create: `app/src/core/rules.ts`
- Test: `app/src/core/rules.test.ts`
- Modify: `app/package.json` (add script `"test:core": "node --test --experimental-strip-types src/core/*.test.ts"`)

**Interfaces:**
- Produces: `type RoomSecurity = { encryption: "on" | "off" | "unknown"; pendingIdentityChange: boolean }`
- Produces: `canSend(r: RoomSecurity): { ok: true } | { ok: false; reason: "not_encrypted" | "encryption_unknown" | "identity_changed" }`
- Produces: `type MessageView = { kind: "text"; body: string } | { kind: "undecryptable" }`
- Produces: `type SendStatus = "sending" | "sent" | "failed"`; `nextStatus(s: SendStatus, e: "ack" | "error" | "retry"): SendStatus`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canSend, nextStatus, renderBody } from "./rules.ts";

test("sending is fail-closed", () => {
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: false }), { ok: true });
  assert.deepEqual(canSend({ encryption: "off", pendingIdentityChange: false }), { ok: false, reason: "not_encrypted" });
  assert.deepEqual(canSend({ encryption: "unknown", pendingIdentityChange: false }), { ok: false, reason: "encryption_unknown" });
  assert.deepEqual(canSend({ encryption: "on", pendingIdentityChange: true }), { ok: false, reason: "identity_changed" });
});

test("undecryptable messages show no content", () => {
  assert.equal(renderBody({ kind: "undecryptable" }), "Unable to decrypt");
  assert.equal(renderBody({ kind: "text", body: "hi" }), "hi");
});

test("message status moves sending → sent or failed → sending", () => {
  assert.equal(nextStatus("sending", "ack"), "sent");
  assert.equal(nextStatus("sending", "error"), "failed");
  assert.equal(nextStatus("failed", "retry"), "sending");
  assert.equal(nextStatus("sent", "error"), "sent");
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd app && node --test --experimental-strip-types src/core/rules.test.ts`
Expected: FAIL, cannot find module `./rules.ts`.

- [ ] **Step 3: Implement**

```ts
export type RoomSecurity = { encryption: "on" | "off" | "unknown"; pendingIdentityChange: boolean };
export type SendCheck = { ok: true } | { ok: false; reason: "not_encrypted" | "encryption_unknown" | "identity_changed" };
export type MessageView = { kind: "text"; body: string } | { kind: "undecryptable" };
export type SendStatus = "sending" | "sent" | "failed";

export function canSend(r: RoomSecurity): SendCheck {
  if (r.encryption === "off") return { ok: false, reason: "not_encrypted" };
  if (r.encryption === "unknown") return { ok: false, reason: "encryption_unknown" };
  if (r.pendingIdentityChange) return { ok: false, reason: "identity_changed" };
  return { ok: true };
}

export function renderBody(m: MessageView): string {
  return m.kind === "text" ? m.body : "Unable to decrypt";
}

export function nextStatus(s: SendStatus, e: "ack" | "error" | "retry"): SendStatus {
  if (s === "sending" && e === "ack") return "sent";
  if (s === "sending" && e === "error") return "failed";
  if (s === "failed" && e === "retry") return "sending";
  return s;
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd app && node --test --experimental-strip-types src/core/rules.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/rules.ts app/src/core/rules.test.ts app/package.json
git commit -m "core: fail-closed send rules and message status"
```

### Task 2: Log redaction, brand tokens and the scaffold-import guard

**Files:**
- Create: `app/src/core/redact.ts`, `app/src/core/theme.ts`
- Test: `app/src/core/redact.test.ts`, `app/src/core/guard.test.ts`

**Interfaces:**
- Produces: `redact(line: string): string`
- Produces: `theme = { paper, ink, muted, line, accent, font, name }` (values in Global Constraints)

- [ ] **Step 1: Write the failing tests**

`redact.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.ts";

test("redacts user ids, tokens and bodies", () => {
  const out = redact('send @alice:fabric.localhost token=syt_abc123 Bearer xyz.987 body="meet at 9"');
  assert.ok(!out.includes("alice"));
  assert.ok(!out.includes("syt_abc123"));
  assert.ok(!out.includes("xyz.987"));
  assert.ok(!out.includes("meet at 9"));
  assert.match(out, /\[user\]/);
});
```

`guard.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { theme } from "./theme.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules" ? [] : d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []);
}

test("the base64 scaffold is never imported", () => {
  const offenders = files(join(import.meta.dirname, "..")).filter((f) => readFileSync(f, "utf8").includes(["@infinitum", "fabric"].join("/")));
  assert.deepEqual(offenders, []);
});

test("brand tokens match the spec", () => {
  assert.deepEqual(
    [theme.paper, theme.ink, theme.muted, theme.line, theme.accent, theme.name],
    ["#ffffff", "#111820", "#52606b", "#d6dce1", "#2454dd", "FabriC++"],
  );
});
```

- [ ] **Step 2: Run to see them fail**

Run: `cd app && node --test --experimental-strip-types src/core/redact.test.ts src/core/guard.test.ts`
Expected: FAIL, modules not found. (The guard test builds the searched string with `join` so it does not match its own source.)

- [ ] **Step 3: Implement**

`redact.ts`:

```ts
export function redact(line: string): string {
  return line
    .replace(/@[A-Za-z0-9._=\-/]+:[A-Za-z0-9.\-]+/g, "[user]")
    .replace(/\b(syt|syr|mat)_[A-Za-z0-9_\-]+/g, "[token]")
    .replace(/Bearer\s+\S+/gi, "Bearer [token]")
    .replace(/(body|password|key)=("[^"]*"|\S+)/gi, "$1=[redacted]");
}
```

`theme.ts`:

```ts
export const theme = {
  paper: "#ffffff",
  ink: "#111820",
  muted: "#52606b",
  line: "#d6dce1",
  accent: "#2454dd",
  font: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  name: "FabriC++",
} as const;
```

- [ ] **Step 4: Run to see them pass**

Run: `cd app && npm run test:core`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/redact.ts app/src/core/theme.ts app/src/core/redact.test.ts app/src/core/guard.test.ts
git commit -m "core: log redaction, brand tokens, guard against the base64 scaffold"
```

### Task 3: Revenue client with payments switched off

**Files:**
- Create: `app/src/core/revenue.ts`
- Test: `app/src/core/revenue.test.ts`

**Interfaces:**
- Produces: `createRevenueClient(opts: { baseUrl: string; token: () => Promise<string>; fetch: typeof fetch; paymentsEnabled: boolean })` returning:
  - `fabricPlan(): Promise<{ plan: "fabric_personal" | "fabric_business"; status: string; seats: number; features: string[] }>` (from `GET /v1/me/entitlements`)
  - `grantDataConsent(): Promise<void>` (`POST /v1/consents` `{ product: "fabric", purpose: "data_licensing" }`)
  - `withdrawDataConsent(): Promise<{ withdrawn: number; delisted: number }>` (`DELETE /v1/consents/fabric?purpose=data_licensing`)
  - `earnings(): Promise<{ availableCents: number; pendingCents: number }>` (`GET /v1/earnings`)
  - `startCheckout(): Promise<never>` and `requestPayout(): Promise<never>` — throw `PaymentsDisabledError` while `paymentsEnabled` is false
- Produces: `formatUsd(cents: number): string`
- Produces: `class PaymentsDisabledError extends Error`

Endpoint paths and response shapes are from `infinitum-revenue` `src/app.ts`, `src/services/billing.ts` (`entitlements`) and `src/services/marketplace.ts` (`earningsBalance`, `withdrawConsent`) at commit c8c4cb9. Those routes currently authenticate an organisation API key; the per-user mobile token is index blocker 2 and is outside this plan.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRevenueClient, formatUsd, PaymentsDisabledError } from "./revenue.ts";

function fakeFetch(routes: Record<string, unknown>, calls: string[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`;
    calls.push(key);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer t1");
    if (!(key in routes)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

test("reads the FABRIC plan, consents, withdraws and reads real earnings", async () => {
  const calls: string[] = [];
  const rc = createRevenueClient({
    baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false,
    fetch: fakeFetch({
      "GET /v1/me/entitlements": { orgId: "o1", credits_cents: 0, products: [
        { product: "scalus", plan: "scalus_free", status: "free", seats: 1, features: [] },
        { product: "fabric", plan: "fabric_personal", status: "free", seats: 1, features: [] }] },
      "POST /v1/consents": { id: "cns_1" },
      "DELETE /v1/consents/fabric?purpose=data_licensing": { withdrawn: 1, delisted: 2 },
      "GET /v1/earnings": { availableCents: 0, pendingCents: 0 },
    }, calls),
  });
  assert.deepEqual(await rc.fabricPlan(), { plan: "fabric_personal", status: "free", seats: 1, features: [] });
  await rc.grantDataConsent();
  assert.deepEqual(await rc.withdrawDataConsent(), { withdrawn: 1, delisted: 2 });
  assert.deepEqual(await rc.earnings(), { availableCents: 0, pendingCents: 0 });
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(7000), "$70.00");
  assert.deepEqual(calls, ["GET /v1/me/entitlements", "POST /v1/consents", "DELETE /v1/consents/fabric?purpose=data_licensing", "GET /v1/earnings"]);
});

test("checkout and payouts make no request while payments are off", async () => {
  const calls: string[] = [];
  const rc = createRevenueClient({ baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false, fetch: fakeFetch({}, calls) });
  await assert.rejects(rc.startCheckout(), PaymentsDisabledError);
  await assert.rejects(rc.requestPayout(), PaymentsDisabledError);
  assert.deepEqual(calls, []);
});

test("a missing FABRIC entitlement is an error, not a guessed plan", async () => {
  const rc = createRevenueClient({ baseUrl: "http://rev.test", token: async () => "t1", paymentsEnabled: false,
    fetch: fakeFetch({ "GET /v1/me/entitlements": { products: [] } }, []) });
  await assert.rejects(rc.fabricPlan(), /no_fabric_entitlement/);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd app && node --test --experimental-strip-types src/core/revenue.test.ts`
Expected: FAIL, cannot find module `./revenue.ts`.

- [ ] **Step 3: Implement**

```ts
export class PaymentsDisabledError extends Error {
  constructor() { super("payments_disabled"); }
}

type Opts = { baseUrl: string; token: () => Promise<string>; fetch: typeof fetch; paymentsEnabled: boolean };
type Plan = { plan: "fabric_personal" | "fabric_business"; status: string; seats: number; features: string[] };

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function createRevenueClient(o: Opts) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await o.fetch(`${o.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await o.token()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`revenue_${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async fabricPlan(): Promise<Plan> {
      const e = await call<{ products: Array<Plan & { product: string }> }>("GET", "/v1/me/entitlements");
      const f = e.products.find((p) => p.product === "fabric");
      if (!f) throw new Error("no_fabric_entitlement");
      return { plan: f.plan, status: f.status, seats: f.seats, features: f.features };
    },
    async grantDataConsent(): Promise<void> {
      await call("POST", "/v1/consents", { product: "fabric", purpose: "data_licensing" });
    },
    withdrawDataConsent(): Promise<{ withdrawn: number; delisted: number }> {
      return call("DELETE", "/v1/consents/fabric?purpose=data_licensing");
    },
    earnings(): Promise<{ availableCents: number; pendingCents: number }> {
      return call("GET", "/v1/earnings");
    },
    // Live checkout and payouts are not wired in this plan; both always refuse without a request.
    async startCheckout(): Promise<never> {
      throw new PaymentsDisabledError();
    },
    async requestPayout(): Promise<never> {
      throw new PaymentsDisabledError();
    },
  };
}
```

`paymentsEnabled` is kept in the options so the screens can show "Not available yet"; turning on live checkout and payouts is a separate, separately approved change.

- [ ] **Step 4: Run to see it pass**

Run: `cd app && npm run test:core`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/revenue.ts app/src/core/revenue.test.ts
git commit -m "core: revenue client for plan, consent and earnings; payments refused"
```

### Task 4: On-device usage counts with no identifiers

**Files:**
- Create: `app/src/core/usage.ts`
- Test: `app/src/core/usage.test.ts`

**Interfaces:**
- Produces: `type DailyUsage = { date: string; sent: number; received: number; sessionSeconds: number }`
- Produces: `class UsageCounter { constructor(consented: () => boolean); onSent(): void; onReceived(): void; addSession(seconds: number): void; flush(date: string): DailyUsage | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageCounter } from "./usage.ts";

test("nothing is counted or released without consent", () => {
  const u = new UsageCounter(() => false);
  u.onSent(); u.onReceived(); u.addSession(30);
  assert.equal(u.flush("2026-11-07"), null);
});

test("counts are numbers and a date only", () => {
  let consented = true;
  const u = new UsageCounter(() => consented);
  u.onSent(); u.onSent(); u.onReceived(); u.addSession(42);
  const d = u.flush("2026-11-07");
  assert.deepEqual(d, { date: "2026-11-07", sent: 2, received: 1, sessionSeconds: 42 });
  assert.deepEqual(Object.keys(d!).sort(), ["date", "received", "sent", "sessionSeconds"]);
  assert.equal(u.flush("2026-11-08"), null);

  u.onSent();
  consented = false;
  assert.equal(u.flush("2026-11-08"), null);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `cd app && node --test --experimental-strip-types src/core/usage.test.ts`
Expected: FAIL, cannot find module `./usage.ts`.

- [ ] **Step 3: Implement**

```ts
export type DailyUsage = { date: string; sent: number; received: number; sessionSeconds: number };

export class UsageCounter {
  private sent = 0;
  private received = 0;
  private seconds = 0;
  private consented: () => boolean;
  constructor(consented: () => boolean) {
    this.consented = consented;
  }

  onSent(): void { if (this.consented()) this.sent++; }
  onReceived(): void { if (this.consented()) this.received++; }
  addSession(seconds: number): void { if (this.consented()) this.seconds += Math.max(0, Math.round(seconds)); }

  /** Returns the day's totals and resets, or null if consent is off or nothing was counted. Withdrawal drops unsent counts. */
  flush(date: string): DailyUsage | null {
    const out = { date, sent: this.sent, received: this.received, sessionSeconds: this.seconds };
    this.sent = 0; this.received = 0; this.seconds = 0;
    if (!this.consented()) return null;
    if (out.sent + out.received + out.sessionSeconds === 0) return null;
    return out;
  }
}
```

- [ ] **Step 4: Run to see it pass**

Run: `cd app && npm run test:core`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/core/usage.ts app/src/core/usage.test.ts
git commit -m "core: consent-gated daily usage counts without identifiers"
```

Plan check: the code in Tasks 1–4 was run once in a throwaway folder on 2026-11-07 with Node 24.22.1: 11 tests, 0 failures. Not yet run inside an Expo app.

How counts become a listed asset (`POST /v1/marketplace/assets` needs `title`, `permittedUses`, `priceCents`, `contentHash`) and the minimum group size for aggregation are server decisions in `infinitum-revenue`; they belong to Stage 5 together with blocker 2. The revenue API also returns only available/pending totals today; the per-sale ledger view the spec describes (section 10.5) needs a new read endpoint in `infinitum-revenue`.
