import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inboundAuth, parseAuthenticationResults, refuseReason } from "./auth-results.ts";
import { PostOffice, PostOfficeStore, MailError } from "./postoffice.ts";

const AR = (value: string) => ({ key: "authentication-results", value });
const CF_PASS = "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1 header.b=AbC; dmarc=pass header.from=example.com policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of a@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@example.com";
const CF_FAIL = "mx.cloudflare.net; dkim=fail header.d=bank.example; dmarc=fail header.from=bank.example policy.dmarc=quarantine; spf=fail smtp.mailfrom=x@evil.example";

describe("Authentication-Results", () => {
  it("parses methods, results and properties, ignoring comments", async () => {
    const p = parseAuthenticationResults(CF_PASS)!;
    assert.equal(p.authservId, "mx.cloudflare.net");
    assert.deepEqual(p.results.map((r) => `${r.method}=${r.result}`), ["dkim=pass", "dmarc=pass", "spf=pass"]);
    assert.equal(p.results[1]!.props["policy.dmarc"], "reject");
    // A comment can't inject a result.
    const sneaky = parseAuthenticationResults("mx.cloudflare.net; dmarc=fail (x; dmarc=pass) header.from=a.example")!;
    assert.deepEqual(sneaky.results.map((r) => r.result), ["fail"]);
    assert.equal(parseAuthenticationResults("@@@; dmarc=pass"), null);
    assert.equal(parseAuthenticationResults(""), null);
  });

  it("trusts only the first header, and only from Cloudflare", async () => {
    const pass = inboundAuth([AR(CF_PASS), AR("evil.example; dmarc=fail")]);
    assert.deepEqual(pass, { verified: true, spf: "pass", dkim: "pass", dmarc: "pass", dmarcPolicy: "reject", fromDomain: "example.com" });
    // A sender-written header below Cloudflare's is ignored ...
    assert.equal(inboundAuth([AR(CF_FAIL), AR("mx.cloudflare.net; dmarc=pass")]).dmarc, "fail");
    // ... and a sender-written header on top (no Cloudflare one) is not trusted at all.
    assert.deepEqual(inboundAuth([AR("mx.cloudflare.net.evil.example; dmarc=pass")]), { verified: false });
    assert.deepEqual(inboundAuth([{ key: "subject", value: "hi" }]), { verified: false });
    assert.deepEqual(inboundAuth([]), { verified: false });
  });

  it("refuses only a trusted dmarc=fail; anything unverified or unknown is delivered", async () => {
    assert.match(refuseReason(inboundAuth([AR(CF_FAIL)]))!, /DMARC/);
    assert.equal(refuseReason(inboundAuth([AR(CF_PASS)])), null);
    assert.equal(refuseReason(inboundAuth([AR("evil.example; dmarc=fail")])), null);
    assert.equal(refuseReason(inboundAuth([AR("mx.cloudflare.net; spf=fail smtp.mailfrom=a@b.example; dmarc=none")])), null);
    assert.equal(refuseReason(inboundAuth([AR("mx.cloudflare.net; dmarc=temperror header.from=b.example")])), null);
    assert.equal(refuseReason(undefined), null);
  });
});

describe("PostOffice.receive with sender authentication", () => {
  const office = () => {
    const po = new PostOffice({ store: new PostOfficeStore() });
    po.provision({ cid: "cid_a", address: "alex@cumuluscloud.app", name: "alex" });
    return po;
  };
  const mail = (auth?: ReturnType<typeof inboundAuth>) => ({
    from: { name: "Bank", email: "x@evil.example" }, recipients: ["alex@cumuluscloud.app"], to: [], cc: [], subject: "Verify your account", body: "Click here", auth,
  });

  it("refuses a message the edge marked dmarc=fail and stores nothing", async () => {
    const po = office();
    await assert.rejects(po.receive(mail(inboundAuth([AR(CF_FAIL)]))), (e: MailError) => e.code === "dmarc_fail");
    assert.equal(po.view("cid_a").messages.filter((m) => m.subject === "Verify your account").length, 0);
  });

  it("delivers authenticated and unchecked mail, keeping the verdict on the message", async () => {
    const po = office();
    assert.deepEqual((await po.receive(mail(inboundAuth([AR(CF_PASS)])))).delivered, ["alex@cumuluscloud.app"]);
    const got = po.view("cid_a").messages.find((m) => m.subject === "Verify your account")!;
    assert.equal(got.auth?.verified, true);
    assert.equal(got.auth?.dmarc, "pass");
    assert.deepEqual((await po.receive(mail())).delivered, ["alex@cumuluscloud.app"]);
  });
});
