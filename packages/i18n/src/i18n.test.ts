import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n, detectLocale, directionOf, format } from "./i18n.js";

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
