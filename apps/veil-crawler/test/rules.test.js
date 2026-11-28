import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_ALL, isAllowed, parseRobots } from "../src/robots.js";
import { crawlable } from "../src/url.js";
import { extract, headerRobots } from "../src/html.js";

test("robots.txt: VEILBot's own group wins over *, longest rule wins, Allow wins ties", () => {
  const r = parseRobots(`
User-agent: *
Disallow: /

User-agent: Googlebot
User-agent: VEILBot
Disallow: /private
Allow: /private/ok
Disallow: /*.php$
Crawl-delay: 7
`);
  assert.equal(r.delay, 7);
  assert.equal(isAllowed(r, "/"), true);
  assert.equal(isAllowed(r, "/private/x"), false);
  assert.equal(isAllowed(r, "/private/ok/1"), true);
  assert.equal(isAllowed(r, "/a.php"), false);
  assert.equal(isAllowed(r, "/a.php?x=1"), true);
  const star = parseRobots("User-agent: *\nDisallow: /search\nDisallow:\n");
  assert.equal(isAllowed(star, "/search?q=1"), false);
  assert.equal(isAllowed(star, "/about"), true);
  assert.equal(isAllowed(parseRobots("User-agent: *\nDisallow: /\n"), "/x"), false);
  assert.equal(isAllowed(ALLOW_ALL, "/anything"), true);
  const tie = parseRobots("User-agent: veilbot\nDisallow: /page\nAllow: /page\n");
  assert.equal(isAllowed(tie, "/page"), true);
});

test("only public web pages are crawlable, and trackers are stripped", () => {
  assert.equal(crawlable("https://Example.COM/a?utm_source=x&id=2#top"), "https://example.com/a?id=2");
  assert.equal(crawlable("/b", "https://example.com/a"), "https://example.com/b");
  for (const bad of [
    "ftp://example.com/", "http://localhost/", "http://192.168.1.1/", "http://[::1]/", "https://user:pw@example.com/",
    "https://example.com:8443/", "https://example.com/login", "https://example.com/cart/", "https://example.com/file.pdf",
    "https://example.com/?sessionid=1", "https://intranet.corp/", "https://x.onion/", "javascript:alert(1)", "https://nodot/",
  ]) assert.equal(crawlable(bad), null, bad);
});

test("reads a page: title, text, links, robots meta, canonical, trackers", () => {
  const html = `<!doctype html><html lang="en-GB"><head><title>Hello &amp; welcome</title>
    <meta name="description" content="A test page"><meta name="robots" content="noindex">
    <link rel="canonical" href="/canon"><script src="https://www.google-analytics.com/analytics.js"></script>
    <script src="/own.js"></script></head><body><nav>Menu</nav><h1>Main</h1><p>Body text here.</p>
    <script>var hidden = "secret";</script><a href="/next">Next</a><a rel="nofollow" href="/ad">Ad</a>
    <img src="https://doubleclick.net/pixel.gif"></body></html>`;
  const p = extract(html, "https://site.example.org/page");
  assert.equal(p.title, "Hello & welcome");
  assert.equal(p.description, "A test page");
  assert.equal(p.lang, "en-gb");
  assert.equal(p.noindex, true);
  assert.equal(p.nofollow, false);
  assert.equal(p.canonical, "https://site.example.org/canon");
  assert.match(p.text, /Main Body text here\. Next Ad/);
  assert.doesNotMatch(p.text, /secret|Menu/);
  assert.deepEqual(p.links, [{ href: "/next", nofollow: false }, { href: "/ad", nofollow: true }]);
  assert.equal(p.trackers, 2);
  assert.deepEqual(headerRobots("googlebot: noindex, veilbot: nofollow"), { noindex: false, nofollow: true });
  assert.deepEqual(headerRobots("none"), { noindex: true, nofollow: true });
});
