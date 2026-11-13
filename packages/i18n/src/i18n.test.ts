import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, detectLocale, directionOf, format, plural } from "./i18n.js";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const catalogs = { en: { hi: "Hello {name}", only: "English only" }, ru: { hi: "Привет, {name}" }, ar: { hi: "مرحبا {name}" } };

test("detects from browser languages and falls back to English", () => {
  store.clear();
  assert.equal(detectLocale({ supported: ["en", "ru"], languages: ["ru-RU", "en"] }), "ru");
  assert.equal(detectLocale({ supported: ["en", "ru"], languages: ["ja-JP"] }), "en");
});

test("a manual choice is remembered and wins over the browser", () => {
  store.clear();
  const i18n = createI18n({ catalogs, locale: "en", autoApply: false });
  i18n.setLocale("ar");
  assert.equal(i18n.locale, "ar");
  assert.equal(i18n.dir, "rtl");
  assert.equal(detectLocale({ supported: ["en", "ru", "ar"], languages: ["ru"] }), "ar");
  i18n.setLocale(null);
  assert.equal(store.size, 0);
});

test("t formats, falls back per key, and supported follows catalogs", () => {
  store.clear();
  const i18n = createI18n({ catalogs, locale: "ru", autoApply: false });
  assert.equal(i18n.t("hi", { name: "Аня" }), "Привет, Аня");
  assert.equal(i18n.t("only"), "English only");
  assert.equal(i18n.t("missing.key"), "missing.key");
  assert.deepEqual(i18n.supported, ["en", "ru", "ar"]);
  i18n.setLocale("de");
  assert.equal(i18n.locale, "ru");
});

test("subscribe fires on change", () => {
  store.clear();
  const i18n = createI18n({ catalogs, locale: "en", autoApply: false });
  const seen: string[] = [];
  const off = i18n.subscribe((l) => seen.push(l));
  i18n.setLocale("ru"); off(); i18n.setLocale("ar");
  assert.deepEqual(seen, ["ru"]);
});

test("helpers", () => {
  assert.equal(directionOf("ar-EG"), "rtl");
  assert.equal(format("{a} {b}", { a: 1 }), "1 {b}");
});

test("lookup matches exact text and {n} patterns", () => {
  store.clear();
  const i18n = createI18n({ catalogs: { en: {}, ru: { "New task": "Новая задача", "{0} / {1} active agents": "{0} из {1} агентов" } }, locale: "ru", autoApply: false });
  assert.equal(i18n.lookup("New task"), "Новая задача");
  assert.equal(i18n.lookup("3 / 5 active agents"), "3 из 5 агентов");
  assert.equal(i18n.lookup("Unknown"), null);
  i18n.setLocale("en");
  assert.equal(i18n.lookup("New task"), null);
});

test("plural blocks pick the form the language needs", () => {
  const ru = "{0, plural, one {# слово} few {# слова} many {# слов} other {# слова}}";
  assert.equal(plural(ru, { 0: 1 }, "ru"), "1 слово");
  assert.equal(plural(ru, { 0: 3 }, "ru"), "3 слова");
  assert.equal(plural(ru, { 0: 5 }, "ru"), "5 слов");
  assert.equal(plural(ru, { 0: 21 }, "ru"), "21 слово");
  assert.equal(plural(ru, { 0: "1,204" }, "ru"), "1,204 слова");
  assert.equal(plural("{n, plural, =0 {No files} one {# file} other {# files}}", { n: 0 }, "en"), "No files");
  assert.equal(plural("{0, plural, one {# file} other {# files}}", {}, "en"), "{0, plural, one {# file} other {# files}}");
  assert.equal(plural("{0, plural, other {# 个文件}}", { 0: 2 }, "zh"), "2 个文件");
});

test("lookup and t resolve plural blocks", () => {
  store.clear();
  const ru = { "{0} words": "{0, plural, one {# слово} few {# слова} many {# слов} other {# слова}}", "{0} · {1} messages": "{0} · {1, plural, one {# письмо} few {# письма} many {# писем} other {# письма}}" };
  const i18n = createI18n({ catalogs: { en: {}, ru }, locale: "ru", autoApply: false });
  assert.equal(i18n.lookup("22 words"), "22 слова");
  assert.equal(i18n.lookup("25 words"), "25 слов");
  assert.equal(i18n.lookup("a@b.c · 11 messages"), "a@b.c · 11 писем");
  assert.equal(i18n.t("{0} words", { 0: 101 }), "101 слово");
});

test("the most specific pattern wins over a generic one", () => {
  store.clear();
  const ru = { "{0} to {1}": "{0} до {1}", "{0} open deals expected to close later.": "Ещё {0, plural, one {# сделка} few {# сделки} many {# сделок} other {# сделки}} закроются позже." };
  const i18n = createI18n({ catalogs: { en: {}, ru }, locale: "ru", autoApply: false });
  assert.equal(i18n.lookup("7 open deals expected to close later."), "Ещё 7 сделок закроются позже.");
  assert.equal(i18n.lookup("May to June"), "May до June");
});
