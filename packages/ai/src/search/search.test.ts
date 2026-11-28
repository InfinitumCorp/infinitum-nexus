import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkCitations,
  createCrawler,
  createSearch,
  createSearchRoutes,
  escapeRobotsPattern,
  extractText,
  isPublicUrl,
  parseRobots,
  parseSearchMention,
  parseYandexXml,
  robotsAllows,
  robotsPath,
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

// Cases ported from Google's robots_test.cc (github.com/google/robotstxt, Apache License 2.0).
const allowed = (txt: string, agent: string, url: string) => robotsAllows(parseRobots(txt, agent), robotsPath(url));

describe("robots.txt (google/robotstxt conformance)", () => {
  it("system test and line syntax", () => {
    const rt = "user-agent: FooBot\ndisallow: /\n";
    assert.equal(allowed("", "FooBot", ""), true);
    assert.equal(allowed(rt, "", ""), true);
    assert.equal(allowed(rt, "FooBot", ""), false);
    const url = "http://foo.bar/x/y";
    assert.equal(allowed("foo: FooBot\nbar: /\n", "FooBot", url), true);
    assert.equal(allowed("user-agent FooBot\ndisallow /\n", "FooBot", url), false);
  });

  it("groups: merged per agent, rules before any user-agent ignored", () => {
    const rt = "allow: /foo/bar/\n\nuser-agent: FooBot\ndisallow: /\nallow: /x/\nuser-agent: BarBot\ndisallow: /\nallow: /y/\n\n\nallow: /w/\nuser-agent: BazBot\n\nuser-agent: FooBot\nallow: /z/\ndisallow: /\n";
    const u = (p: string) => `http://foo.bar${p}`;
    assert.equal(allowed(rt, "FooBot", u("/x/b")), true);
    assert.equal(allowed(rt, "FooBot", u("/z/d")), true);
    assert.equal(allowed(rt, "FooBot", u("/y/c")), false);
    assert.equal(allowed(rt, "BarBot", u("/y/c")), true);
    assert.equal(allowed(rt, "BarBot", u("/w/a")), true);
    assert.equal(allowed(rt, "BarBot", u("/z/d")), false);
    assert.equal(allowed(rt, "BazBot", u("/z/d")), true);
    for (const a of ["FooBot", "BarBot", "BazBot"]) assert.equal(allowed(rt, a, u("/foo/bar/")), false, a);
  });

  it("Sitemap and unknown lines don't end a group", () => {
    for (const mid of ["Sitemap: https://foo.bar/sitemap", "Invalid-Unknown-Line: unknown"]) {
      const rt = `User-agent: BarBot\n${mid}\nUser-agent: *\nDisallow: /\n`;
      assert.equal(allowed(rt, "FooBot", "http://foo.bar/"), false);
      assert.equal(allowed(rt, "BarBot", "http://foo.bar/"), false);
    }
  });

  it("keys and user-agent values are case-insensitive; the agent is cut at the first space", () => {
    for (const rt of ["USER-AGENT: FooBot\nALLOW: /x/\nDISALLOW: /\n", "uSeR-aGeNt: FooBot\nAlLoW: /x/\ndIsAlLoW: /\n", "User-Agent: FoO bAr\nAllow: /x/\nDisallow: /\n"]) {
      const agent = rt.includes("bAr") ? "foo" : "FooBot";
      assert.equal(allowed(rt, agent, "http://foo.bar/x/y"), true);
      assert.equal(allowed(rt, agent, "http://foo.bar/a/b"), false);
    }
    const rt = "User-Agent: *\nDisallow: /\nUser-Agent: Foo Bar\nAllow: /x/\nDisallow: /\n";
    assert.equal(allowed(rt, "Foo", "http://foo.bar/x/y"), true);
    assert.equal(allowed(rt, "Foo Bar", "http://foo.bar/x/y"), false);
  });

  it("global groups apply only when no group names us", () => {
    const url = "http://foo.bar/x/y";
    assert.equal(allowed("", "FooBot", url), true);
    const global = "user-agent: *\nallow: /\nuser-agent: FooBot\ndisallow: /\n";
    assert.equal(allowed(global, "FooBot", url), false);
    assert.equal(allowed(global, "BarBot", url), true);
    assert.equal(allowed("user-agent: FooBot\nallow: /\nuser-agent: BarBot\ndisallow: /\nuser-agent: BazBot\ndisallow: /\n", "QuxBot", url), true);
    const both = "User-agent: *\nDisallow: /x/\nUser-agent: FooBot\nDisallow: /y/\n";
    assert.equal(allowed(both, "FooBot", "http://foo.bar/x/page"), true);
    assert.equal(allowed(both, "FooBot", "http://foo.bar/y/page"), false);
  });

  it("values are case-sensitive; the longest match wins and Allow wins ties", () => {
    const url = "http://foo.bar/x/page.html";
    assert.equal(allowed("user-agent: FooBot\ndisallow: /x/\n", "FooBot", "http://foo.bar/x/y"), false);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /X/\n", "FooBot", "http://foo.bar/x/y"), true);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /x/page.html\nallow: /x/\n", "FooBot", url), false);
    assert.equal(allowed("user-agent: FooBot\nallow: /x/page.html\ndisallow: /x/\n", "FooBot", url), true);
    assert.equal(allowed("user-agent: FooBot\nallow: /x/page.html\ndisallow: /x/\n", "FooBot", "http://foo.bar/x/"), false);
    assert.equal(allowed("user-agent: FooBot\ndisallow: \nallow: \n", "FooBot", url), true);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /\nallow: /\n", "FooBot", url), true);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /x\nallow: /x/\n", "FooBot", "http://foo.bar/x"), false);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /x\nallow: /x/\n", "FooBot", "http://foo.bar/x/"), true);
    assert.equal(allowed("user-agent: FooBot\ndisallow: /x/page.html\nallow: /x/page.html\n", "FooBot", url), true);
    assert.equal(allowed("user-agent: FooBot\nallow: /page\ndisallow: /*.html\n", "FooBot", "http://foo.bar/page.html"), false);
    assert.equal(allowed("user-agent: FooBot\nallow: /page\ndisallow: /*.html\n", "FooBot", "http://foo.bar/page"), true);
    assert.equal(allowed("user-agent: FooBot\nallow: /x/page.\ndisallow: /*.html\n", "FooBot", url), true);
    assert.equal(allowed("user-agent: FooBot\nallow: /x/page.\ndisallow: /*.html\n", "FooBot", "http://foo.bar/x/y.html"), false);
  });

  it("encoding: patterns are %-normalised, paths are used as given", () => {
    const q = "/foo/bar?qux=taz&baz=http://foo.bar?tar&par";
    assert.equal(allowed(`User-agent: FooBot\nDisallow: /\nAllow: ${q}\n`, "FooBot", `http://foo.bar${q}`), true);
    for (const allow of ["/foo/bar/ツ", "/foo/bar/%E3%83%84"]) {
      const rt = `User-agent: FooBot\nDisallow: /\nAllow: ${allow}\n`;
      assert.equal(allowed(rt, "FooBot", "http://foo.bar/foo/bar/%E3%83%84"), true);
      assert.equal(allowed(rt, "FooBot", "http://foo.bar/foo/bar/ツ"), false);
    }
    const rt = "User-agent: FooBot\nDisallow: /\nAllow: /foo/bar/%62%61%7A\n";
    assert.equal(allowed(rt, "FooBot", "http://foo.bar/foo/bar/baz"), false);
    assert.equal(allowed(rt, "FooBot", "http://foo.bar/foo/bar/%62%61%7A"), true);
    assert.equal(escapeRobotsPattern("http://www.example.com"), "http://www.example.com");
    assert.equal(escapeRobotsPattern("á"), "%C3%A1");
    assert.equal(escapeRobotsPattern("%aa"), "%AA");
  });

  it("special characters: *, a final $, and # comments", () => {
    const star = "User-agent: FooBot\nDisallow: /foo/bar/quz\nAllow: /foo/*/qux\n";
    assert.equal(allowed(star, "FooBot", "http://foo.bar/foo/bar/quz"), false);
    for (const p of ["/foo/quz", "/foo//quz", "/foo/bax/quz"]) assert.equal(allowed(star, "FooBot", `http://foo.bar${p}`), true, p);
    const dollar = "User-agent: FooBot\nDisallow: /foo/bar$\nAllow: /foo/bar/qux\n";
    assert.equal(allowed(dollar, "FooBot", "http://foo.bar/foo/bar"), false);
    for (const p of ["/foo/bar/qux", "/foo/bar/", "/foo/bar/baz"]) assert.equal(allowed(dollar, "FooBot", `http://foo.bar${p}`), true, p);
    const hash = "User-agent: FooBot\n# Disallow: /\nDisallow: /foo/quz#qux\nAllow: /\n";
    assert.equal(allowed(hash, "FooBot", "http://foo.bar/foo/bar"), true);
    assert.equal(allowed(hash, "FooBot", "http://foo.bar/foo/quz"), false);
  });

  it("index.html is the directory; typos, BOM and CR line endings are accepted", () => {
    const rt = "User-Agent: *\nAllow: /allowed-slash/index.html\nDisallow: /\n";
    assert.equal(allowed(rt, "foobot", "http://foo.com/allowed-slash/"), true);
    assert.equal(allowed(rt, "foobot", "http://foo.com/allowed-slash/index.htm"), false);
    assert.equal(allowed(rt, "foobot", "http://foo.com/allowed-slash/index.html"), true);
    assert.equal(allowed(rt, "foobot", "http://foo.com/anyother-url"), false);
    assert.equal(allowed("useragent: FooBot\ndissallow: /\n", "FooBot", "http://foo.bar/a"), false);
    assert.equal(allowed("﻿User-Agent: foo\r\nDisallow: /a\rAllow: /a/b\n", "foo", "http://foo.bar/a/c"), false);
    assert.equal(allowed("﻿User-Agent: foo\r\nDisallow: /a\rAllow: /a/b\n", "foo", "http://foo.bar/a/b"), true);
  });

  it("cuts lines longer than Google's limit", () => {
    const max = 2083 * 8;
    const long = "/x/" + "a".repeat(max - 3 - "disallow: ".length + 1 - 3);
    const rt = `user-agent: FooBot\ndisallow: ${long}/qux\n`;
    assert.equal(allowed(rt, "FooBot", "http://foo.bar/fux"), true);
    assert.equal(allowed(rt, "FooBot", `http://foo.bar${long}/fux`), false);
  });

  it("robotsPath extracts path, params and query", () => {
    const cases: [string, string][] = [
      ["", "/"], ["http://www.example.com", "/"], ["http://www.example.com/a/", "/a/"],
      ["http://www.example.com/a/b?c=http://d.e/", "/a/b?c=http://d.e/"], ["http://www.example.com/a/b?c=d&e=f#fragment", "/a/b?c=d&e=f"],
      ["example.com", "/"], ["example.com/a", "/a"], ["a", "/"], ["a/", "/"], ["/a", "/a"], ["a/b", "/b"],
      ["example.com?a", "/?a"], ["example.com/a;b#c", "/a;b"], ["//a/b/c", "/b/c"],
    ];
    for (const [url, path] of cases) assert.equal(robotsPath(url), path, url);
  });

  it("always allows /robots.txt itself", () => {
    assert.equal(allowed("User-agent: *\nDisallow: /\n", "InfinitumSearch", "https://a.example/robots.txt"), true);
    assert.equal(parseRobots("User-agent: InfinitumSearch\nDisallow: /\n\nUser-agent: *\nDisallow:").group, "specific");
  });
});

describe("crawler", () => {

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

describe("VEIL engine", () => {
  it("POSTs the query in the body, keeps http(s) results, and is picked up from VEIL_SEARCH_URL", async () => {
    const { veilEngine, enginesFromEnv } = await import("./search.mjs");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ q: "x", sources: ["veil", "wikipedia"], results: [
        { title: "<b>Gemma</b> 4", url: "https://example.org/gemma", snippet: "31B &amp; 26B", sources: ["veil"] },
        { title: "bad", url: "javascript:alert(1)" },
      ] });
    }) as unknown as typeof fetch;
    const engine = veilEngine({ url: "https://veil.test/api/search", fetch: fetchImpl });
    assert.deepEqual(await engine.search("gemma 4 sizes"), [{ title: "Gemma 4", url: "https://example.org/gemma", snippet: "31B & 26B" }]);
    assert.equal(calls[0]!.url, "https://veil.test/api/search");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal(JSON.parse(String(calls[0]!.init.body)).q, "gemma 4 sizes");

    assert.deepEqual(enginesFromEnv({ VEIL_SEARCH_URL: "https://infinitumveil.app/api/search" }).map((e: { name: string }) => e.name), ["veil"]);
    assert.throws(() => enginesFromEnv({ VEIL_SEARCH_URL: "http://infinitumveil.app/api/search" }), /https/);
    const failing = veilEngine({ fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    await assert.rejects(failing.search("q"), /VEIL Search returned 500/);
  });
});

describe("Exa engine", () => {
  it("POSTs the query with x-api-key, maps highlights, drops non-http results", async () => {
    const { exaEngine } = await import("./search.mjs");
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ results: [
        { title: "Exa doc", url: "https://exa.example/a", highlights: ["first.", "second."] },
        { title: "Text only", url: "https://exa.example/b", text: "body text" },
        { title: "Bad", url: "javascript:alert(1)" },
      ] }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await exaEngine({ apiKey: "ek", fetch: fetchImpl }).search("graph databases");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.exa.ai/search");
    assert.equal(calls[0]!.init.method, "POST");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["x-api-key"], "ek");
    assert.equal(JSON.parse(String(calls[0]!.init.body)).query, "graph databases");
    assert.deepEqual(r.map((x: { url: string }) => x.url), ["https://exa.example/a", "https://exa.example/b"]);
    assert.equal(r[0]!.snippet, "first. second.");
    assert.equal(r[1]!.snippet, "body text");
  });

  it("reports a refused key as a SearchError", async () => {
    const { exaEngine } = await import("./search.mjs");
    const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(exaEngine({ apiKey: "bad", fetch: fetchImpl }).search("q"), /refused/);
  });

  it("is on when EXA_API_KEY is set, ordered after SearXNG and before Yandex/Brave, and EXA_SEARCH=off removes it", async () => {
    const { enginesFromEnv } = await import("./search.mjs");
    const env = { SEARXNG_URL: "https://searx.example", EXA_API_KEY: "ek", YANDEX_SEARCH_API_KEY: "k", YANDEX_FOLDER_ID: "f", BRAVE_SEARCH_API_KEY: "b" };
    assert.deepEqual(enginesFromEnv(env).map((e: { name: string }) => e.name), ["searxng", "exa", "yandex", "brave"]);
    assert.deepEqual(enginesFromEnv({ ...env, EXA_SEARCH: "off" }).map((e: { name: string }) => e.name), ["searxng", "yandex", "brave"]);
    assert.deepEqual(enginesFromEnv({}), []);
  });
});
