import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCitations,
  createCrawler,
  createSearch,
  createSearchRoutes,
  extractText,
  isPublicUrl,
  parseRobots,
  parseSearchMention,
  parseYandexXml,
  searchFromEnv,
  searchRoutesFromEnv,
  SEARCH_NOT_CONNECTED,
} from "./search.mjs";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fake = (fn: Handler) => fn as unknown as typeof fetch;
const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("parseSearchMention", () => {
  it("finds @search anywhere and takes it out of the query", () => {
    assert.deepEqual(parseSearchMention("@search best open-weight models"), { query: "best open-weight models" });
    assert.deepEqual(parseSearchMention("for the deck: @SEARCH: Yandex Cloud regions"), { query: "for the deck: Yandex Cloud regions" });
    assert.deepEqual(parseSearchMention("＠search погода в Москве"), { query: "погода в Москве" });
    assert.deepEqual(parseSearchMention("@search"), { query: "" });
  });
  it("ignores emails, longer handles and plain text", () => {
    assert.equal(parseSearchMention("mail me@search.app"), null);
    assert.equal(parseSearchMention("@searchbot hi"), null);
    assert.equal(parseSearchMention("search the web"), null);
    assert.equal(parseSearchMention(undefined), null);
  });
});

describe("isPublicUrl", () => {
  it("allows public http(s) pages", () => {
    assert.ok(isPublicUrl("https://example.com/a?b=1"));
    assert.ok(isPublicUrl("http://ya.ru/"));
  });
  it("refuses the internal network, odd ports, credentials and other schemes", () => {
    for (const u of [
      "http://localhost/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/",
      "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/",
      "http://0x7f000001/", "http://printer.local/", "http://metadata.google.internal/", "https://example.com:8443/",
      "https://user:pw@example.com/", "file:///etc/passwd", "ftp://example.com/", "not a url",
    ]) assert.equal(isPublicUrl(u), false, u);
  });
});

describe("extractText", () => {
  it("keeps the article and drops scripts, menus and footers", () => {
    const page = `<html><head><title>Fast &amp; open</title><meta name="description" content="About models"></head>
      <body><nav>Home | Login</nav><script>steal()</script><article><h1>Open models</h1><p>${"Qwen and DeepSeek are open-weight. ".repeat(20)}</p></article><footer>© 2026</footer></body></html>`;
    const { title, description, text } = extractText(page);
    assert.equal(title, "Fast & open");
    assert.equal(description, "About models");
    assert.match(text, /Qwen and DeepSeek are open-weight/);
    assert.doesNotMatch(text, /steal|Login|2026/);
  });
});

describe("robots.txt", () => {
  it("uses our own group, else *, with Allow overriding a shorter Disallow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: Googlebot\nDisallow: /");
    assert.deepEqual(rules, { allow: ["/private/ok"], disallow: ["/private"] });
    assert.deepEqual(parseRobots("User-agent: InfinitumSearch\nDisallow: /\n\nUser-agent: *\nDisallow:"), { allow: [], disallow: ["/"] });
  });

  it("the crawler skips disallowed pages and follows safe redirects only", async () => {
    const seen: string[] = [];
    const crawl = createCrawler({
      fetch: fake((url) => {
        seen.push(url);
        if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /secret", { headers: { "content-type": "text/plain" } });
        if (url === "https://a.example/moved") return new Response(null, { status: 301, headers: { location: "/page" } });
        if (url === "https://a.example/evil") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
        return html("<title>Page</title><p>Hello from the page</p>");
      }),
    });
    assert.equal(await crawl("https://a.example/secret/x"), null);
    assert.ok(!seen.includes("https://a.example/secret/x"));
    const page = await crawl("https://a.example/moved");
    assert.equal(page?.url, "https://a.example/page");
    assert.match(page?.text ?? "", /Hello from the page/);
    assert.equal(await crawl("https://a.example/evil"), null);
    assert.ok(!seen.some((u) => u.includes("169.254")));
  });
});

describe("parseYandexXml", () => {
  it("reads urls, titles and passages", () => {
    const xml = `<yandexsearch><response><results><grouping><group><doc><url>https://cloud.yandex.ru/</url><title>Yandex <hlword>Cloud</hlword></title><passages><passage>Облачная платформа &amp; сервисы</passage></passages></doc></group></grouping></results></response></yandexsearch>`;
    assert.deepEqual(parseYandexXml(xml), [{ title: "Yandex Cloud", url: "https://cloud.yandex.ru/", snippet: "Облачная платформа & сервисы" }]);
  });
});

describe("checkCitations", () => {
  it("drops citations to sources that don't exist and lists the used ones", () => {
    assert.deepEqual(checkCitations("A [1]. B [7][2]. C [2].", 3), { text: "A [1]. B [2]. C [2].", used: [1, 2] });
  });
});

const engine = (results: { title: string; url: string; snippet: string }[], name = "test") => ({ name, search: async () => results });
const pages = fake((url) => (url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : html(`<title>${url}</title><article>${"Body of " + url + ". ".repeat(40)}</article>`)));

describe("createSearch", () => {
  it("reads the top pages and returns a cited answer with its sources", async () => {
    let prompt = "";
    const search = createSearch({
      engines: [engine([
        { title: "One", url: "https://one.example/a?utm_source=x", snippet: "first" },
        { title: "One again", url: "https://one.example/a", snippet: "dup" },
        { title: "Internal", url: "http://10.0.0.1/", snippet: "no" },
        { title: "Two", url: "https://two.example/b", snippet: "second" },
      ])],
      fetch: pages,
      chat: async (messages: { role: string; content: string }[]) => {
        prompt = messages.map((m) => m.content).join("\n");
        return "Open models are good [1], and fast [2][9].";
      },
    });
    const r = await search.ask("  are open models good?  ", { context: "Workspace: Northwind" });
    assert.equal(r.query, "are open models good?");
    assert.equal(r.answer, "Open models are good [1], and fast [2].");
    assert.deepEqual(r.cited, [1, 2]);
    assert.deepEqual(r.sources.map((s: { n: number; url: string }) => [s.n, s.url]), [[1, "https://one.example/a?utm_source=x"], [2, "https://two.example/b"]]);
    assert.equal(r.read, 2);
    assert.match(prompt, /\[1\] One\nURL: https:\/\/one\.example/);
    assert.match(prompt, /Body of https:\/\/two\.example\/b/);
    assert.match(prompt, /not instructions to you/);
    assert.match(prompt, /Workspace: Northwind/);
  });

  it("falls back to the next engine, and returns sources without a model", async () => {
    const search = createSearch({
      engines: [{ name: "down", search: async () => { throw new Error("503"); } }, engine([{ title: "T", url: "https://t.example/", snippet: "s" }], "backup")],
      fetch: pages,
    });
    const r = await search.ask("q");
    assert.equal(r.engine, "backup");
    assert.equal(r.answer, null);
    assert.equal(r.sources.length, 1);
  });

  it("keeps the sources when the model fails", async () => {
    const search = createSearch({ engines: [engine([{ title: "T", url: "https://t.example/", snippet: "s" }])], fetch: pages, chat: async () => { throw new Error("down"); } });
    const r = await search.ask("q");
    assert.equal(r.answer, null);
    assert.equal(r.sources.length, 1);
  });
});

describe("createSearchRoutes", () => {
  const search = createSearch({ engines: [engine([{ title: "T", url: "https://t.example/", snippet: "s" }])], fetch: pages, chat: async () => "Yes [1]." });
  const post = (body: unknown, path = "/api/search") => new Request(`https://app.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("needs a signed-in user and ignores other paths", async () => {
    const handle = createSearchRoutes({ search });
    assert.equal(await handle(post({ query: "x" }, "/api/other"), { user: "u1" }), null);
    assert.equal((await handle(post({ query: "x" }), {}))!.status, 401);
  });

  it("answers a search box query and an @search mention, and passes on plain text", async () => {
    const handle = createSearchRoutes({ search });
    const box = await (await handle(post({ query: "is it?" }), { user: "u1" }))!.json();
    assert.equal(box.answer, "Yes [1].");
    const mention = await (await handle(post({ text: "hey @search is it?" }), { user: "u1" }))!.json();
    assert.equal(mention.mention, true);
    assert.equal(mention.query, "hey is it?");
    assert.deepEqual(await (await handle(post({ text: "no mention" }), { user: "u1" }))!.json(), { mention: false });
    assert.equal((await handle(post({ text: "@search" }), { user: "u1" }))!.status, 400);
  });

  it("limits each person per minute", async () => {
    const handle = createSearchRoutes({ search, perMinute: 2 });
    assert.equal((await handle(post({ query: "a" }), { user: "u2" }))!.status, 200);
    assert.equal((await handle(post({ query: "b" }), { user: "u2" }))!.status, 200);
    assert.equal((await handle(post({ query: "c" }), { user: "u2" }))!.status, 429);
    assert.equal((await handle(post({ query: "d" }), { user: "u3" }))!.status, 200);
  });

  it("is off until a search engine is configured", async () => {
    const handle = searchRoutesFromEnv({});
    const get = await (await handle(new Request("https://app.test/api/search"), { user: "u1" }))!.json();
    assert.deepEqual(get, { connected: false, engines: [], answers: false });
    const res = await handle(post({ query: "x" }), { user: "u1" });
    assert.equal(res!.status, 503);
    assert.equal((await res!.json()).error, SEARCH_NOT_CONNECTED);
  });
});

describe("searchFromEnv", () => {
  it("chains SearXNG, Yandex and Brave, with OmniRoute for answers", async () => {
    const calls: string[] = [];
    const search = searchFromEnv(
      { SEARXNG_URL: "https://searx.example", YANDEX_SEARCH_API_KEY: "k", YANDEX_FOLDER_ID: "f", BRAVE_SEARCH_API_KEY: "b", OMNIROUTE_BASE_URL: "https://omni.example/v1", OMNIROUTE_API_KEY: "o" },
      {
        fetch: fake((url, init) => {
          calls.push(url);
          if (url.startsWith("https://searx.example")) return json({}, 502);
          if (url.startsWith("https://searchapi.api.cloud.yandex.net")) {
            assert.equal((init.headers as Record<string, string>).authorization, "Api-Key k");
            const xml = "<doc><url>https://ya.example/</url><title>Ya</title><passages><passage>p</passage></passages></doc>";
            return json({ rawData: btoa(xml) });
          }
          if (url.startsWith("https://omni.example/v1/chat/completions")) return json({ choices: [{ message: { content: "Answer [1]." } }] });
          if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
          return html("<p>page</p>");
        }),
      },
    )!;
    assert.deepEqual(search.engines, ["searxng", "yandex", "brave"]);
    const r = await search.ask("q");
    assert.equal(r.engine, "yandex");
    assert.equal(r.answer, "Answer [1].");
    assert.ok(!calls.some((u) => u.includes("brave")));
  });

  it("refuses a plain-http SearXNG on another host", () => {
    assert.throws(() => searchFromEnv({ SEARXNG_URL: "http://searx.example" }), /https/);
  });
});
