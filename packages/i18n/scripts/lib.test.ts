import { test } from "node:test";
import assert from "node:assert/strict";
import {
  androidLocaleDir, chromeLocaleDir, escapeAndroid, findBadTranslations, parseJsonObject, readAndroidStrings, writeAndroidStrings,
} from "./lib.ts";

test("parseJsonObject tolerates fences and thinking", () => {
  assert.deepEqual(parseJsonObject('<think>hm {x}</think>```json\n{"a":"б"}\n```'), { a: "б" });
});

test("findBadTranslations flags lost placeholders and tags", () => {
  const src = { a: "Hi {name}", b: "<b>Bold</b>", c: "Plain", d: "Gone" };
  assert.deepEqual(findBadTranslations(src, { a: "Привет", b: "<b>Жирный</b>", c: "Просто", d: "" }), ["a", "d"]);
});

test("android strings round-trip with escapes", () => {
  const c = { quote: `It's "here"\nnext`, at: "@home", amp: "A & B <c>" };
  const xml = writeAndroidStrings(c);
  assert.deepEqual(readAndroidStrings(xml), c);
  assert.equal(escapeAndroid("@x"), "\\@x");
  assert.deepEqual(readAndroidStrings('<resources><string name="k" translatable="false">x</string><string name="j">y</string></resources>'), { j: "y" });
});

test("locale folders", () => {
  assert.equal(androidLocaleDir("zh"), "values-zh-rCN");
  assert.equal(androidLocaleDir("ru"), "values-ru");
  assert.equal(chromeLocaleDir("pt"), "pt_BR");
  assert.equal(chromeLocaleDir("ar"), "ar");
});

test("a plural block counts as its placeholder", () => {
  const src = { a: "{0} words", b: "{0} · {1} messages" };
  const good = { a: "{0, plural, one {# слово} few {# слова} many {# слов} other {# слова}}", b: "{0} · {1, plural, one {# письмо} other {# письма}}" };
  assert.deepEqual(findBadTranslations(src, good), []);
  assert.deepEqual(findBadTranslations(src, { a: "{1, plural, one {# слово} other {# слов}}", b: "{0} · письма" }), ["a", "b"]);
});
