import { describe, it } from "node:test";
import assert from "node:assert/strict";

const path = "../public/search.js";
const { tokenize, parseQuery, searchThreads }: any = await import(path);

const NOW = Date.parse("2026-11-06T12:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const who = (name: string) => ({ name, email: `${name.toLowerCase()}@cumuluscloud.app` });
const msg = (over: Record<string, unknown>) => ({
  id: String(Math.random()), threadId: "t", folder: "inbox", from: who("Leah"), to: [who("Alex")], cc: [],
  subject: "Hello", body: "", at: day(0), unread: false, starred: false, kind: "person", attachments: [], ...over,
});

const mail = [
  msg({ id: "1", threadId: "a", subject: "Quarterly plan", body: "The draft plan is attached", attachments: [{ name: "plan.pdf", size: 1 }], unread: true }),
  msg({ id: "2", threadId: "b", subject: "Rent", body: "Paid", payment: { asset: "USDC", amount: "10" }, at: day(10) }),
  msg({ id: "3", threadId: "c", subject: "Weekly digest", from: who("News"), kind: "newsletter", folder: "archive", at: day(40) }),
  msg({ id: "4", threadId: "d", subject: "Old plan", folder: "trash" }),
  msg({ id: "5", threadId: "e", subject: "Unsent plan", folder: "drafts" }),
];
const ids = (q: string) => searchThreads(mail, q, NOW).map((m: any) => m.id);

describe("Search", () => {
  it("keeps quoted phrases and minus signs", () => {
    assert.deepEqual(tokenize('"draft plan" -from:news is:unread'), [
      { negate: false, key: "", value: "draft plan" },
      { negate: true, key: "from", value: "news" },
      { negate: false, key: "is", value: "unread" },
    ]);
    assert.equal(parseQuery("in:all plan").box, "anywhere");
  });

  it("searches all mail but Trash and Drafts unless in: says otherwise", () => {
    assert.deepEqual(ids("plan"), ["1"]);
    assert.deepEqual(ids("plan in:anywhere").sort(), ["1", "4", "5"]);
    assert.deepEqual(ids("in:trash"), ["4"]);
    assert.deepEqual(ids("digest"), ["3"], "archived mail is found");
  });

  it("understands Gmail operators", () => {
    assert.deepEqual(ids('"draft plan"'), ["1"]);
    assert.deepEqual(ids('"plan draft"'), []);
    assert.deepEqual(ids("has:attachment"), ["1"]);
    assert.deepEqual(ids("has:payment"), ["2"]);
    assert.deepEqual(ids("is:unread"), ["1"]);
    assert.deepEqual(ids("category:updates"), ["3"]);
    assert.deepEqual(ids("newer_than:1w"), ["1"]);
    assert.deepEqual(ids("older_than:30d"), ["3"]);
    assert.deepEqual(ids("-from:leah"), ["3"]);
    assert.deepEqual(ids("to:alex rent"), ["2"]);
  });
});
