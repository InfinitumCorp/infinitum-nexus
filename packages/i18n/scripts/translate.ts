// Build-time translation for every Infinitum app.
//
// Reads the English catalog an app commits, translates new or changed strings
// into every shipped language with the open-weight models behind @infinitum/ai
// (OmniRoute first, then whatever hosts are configured), validates the result
// and writes catalogs the app commits. Apps never call a model at runtime.
//
//   node --experimental-strip-types packages/i18n/scripts/translate.ts --dir <locales dir>
//        [--bundle <catalogs.js>] [--android <res dir>] [--chrome <_locales dir>]
//        [--locales ru,uk,...] [--check] [--batch 30]
//
// <locales dir>/en.json            source strings (flat { key: "English" })
// <locales dir>/i18n.config.json   optional { "context": "...", "keep": ["SCALVS.ai", ...] }
// <locales dir>/.en-snapshot.json  English as last translated (changed keys are redone)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { sharedRouter } from "../../ai/src/index.ts";
import { LOCALES } from "../src/i18n.js";
import {
  androidLocaleDir, chromeLocaleDir, findBadTranslations, parseJsonObject, readAndroidStrings, writeAndroidStrings,
} from "./lib.ts";

type Catalog = Record<string, string>;

const { values: args } = parseArgs({
  options: {
    dir: { type: "string" },
    bundle: { type: "string" },
    android: { type: "string" },
    chrome: { type: "string" },
    locales: { type: "string" },
    check: { type: "boolean", default: false },
    batch: { type: "string", default: "30" },
  },
});

const NAMES: Record<string, string> = {
  ru: "Russian", uk: "Ukrainian", es: "Spanish", fr: "French", de: "German",
  pt: "Portuguese (Brazil)", zh: "Simplified Chinese", ar: "Arabic",
};
const targets = (args.locales ? args.locales.split(",") : LOCALES.map((l) => l.code)).filter((c) => c !== "en");
const batchSize = Number(args.batch);

const readJson = <T,>(path: string, fallback: T): T => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const writeJson = (path: string, data: unknown) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};
const sortKeys = (c: Catalog, order: string[]): Catalog => Object.fromEntries(order.filter((k) => k in c).map((k) => [k, c[k]]));

async function translateBatch(lang: string, batch: Catalog, config: { context?: string; keep?: string[] }): Promise<Catalog> {
  const ai = sharedRouter();
  const keep = ["Infinitum", ...(config.keep ?? [])];
  const system = [
    "Reasoning: low.",
    `You translate software user-interface strings from English into ${NAMES[lang] ?? lang}.`,
    config.context ? `Product context: ${config.context}` : "",
    "Return only a JSON object with exactly the same keys as the input, each value translated.",
    "Keep these unchanged: {placeholders}, HTML tags and attributes, URLs, e-mail addresses, numbers, keyboard keys,",
    `and these names: ${keep.join(", ")}.`,
    "Use short, natural UI wording a native speaker expects (buttons as verbs, no quotes around values).",
  ].filter(Boolean).join("\n");
  const raw = await ai.complete(system, JSON.stringify(batch, null, 1), { tier: "smart", temperature: 0, maxTokens: 8000 });
  const out = parseJsonObject(raw);
  const result: Catalog = {};
  for (const k of Object.keys(batch)) if (typeof out[k] === "string" && out[k].trim()) result[k] = out[k];
  return result;
}

async function translateAll(lang: string, todo: Catalog, config: { context?: string; keep?: string[] }, onBatch?: (done: Catalog) => void): Promise<Catalog> {
  const keys = Object.keys(todo);
  const done: Catalog = {};
  for (let i = 0; i < keys.length; i += batchSize) {
    let pending = Object.fromEntries(keys.slice(i, i + batchSize).map((k) => [k, todo[k]]));
    for (let attempt = 0; attempt < 3 && Object.keys(pending).length; attempt++) {
      try {
        const got = await translateBatch(lang, pending, config);
        const bad = new Set(findBadTranslations(pending, got));
        for (const [k, v] of Object.entries(got)) if (!bad.has(k)) { done[k] = v; delete pending[k]; }
      } catch (err) {
        console.warn(`  ${lang}: batch failed (${(err as Error).message.slice(0, 160)})`);
      }
    }
    const left = Object.keys(pending);
    if (left.length) console.warn(`  ${lang}: ${left.length} string(s) left in English: ${left.join(", ")}`);
    onBatch?.(done);
    process.stdout.write(`  ${lang}: ${Math.min(i + batchSize, keys.length)}/${keys.length}\n`);
  }
  return done;
}

/** Translate one flat source catalog into `existing` catalogs, redoing changed keys. */
async function sync(
  source: Catalog, snapshot: Catalog, load: (lang: string) => Catalog, save: (lang: string, c: Catalog) => void,
  config: { context?: string; keep?: string[] },
): Promise<number> {
  const order = Object.keys(source);
  const changed = new Set(order.filter((k) => snapshot[k] !== undefined && snapshot[k] !== source[k]));
  let missingTotal = 0;
  for (const lang of targets) {
    const current = load(lang);
    const todo: Catalog = {};
    for (const k of order) if (!(k in current) || changed.has(k)) todo[k] = source[k];
    if (args.check) { missingTotal += Object.keys(todo).length; if (Object.keys(todo).length) console.log(`${lang}: ${Object.keys(todo).length} missing`); continue; }
    if (!Object.keys(todo).length) { console.log(`  ${lang}: up to date`); continue; }
    console.log(`  ${lang}: translating ${Object.keys(todo).length} string(s)`);
    for (const k of changed) delete current[k];
    const done = await translateAll(lang, todo, config, (partial) => save(lang, sortKeys({ ...current, ...partial }, order)));
    save(lang, sortKeys({ ...current, ...done }, order));
  }
  return missingTotal;
}

let missing = 0;

if (args.dir) {
  const dir = args.dir;
  const source: Catalog = readJson(join(dir, "en.json"), {});
  const config = readJson(join(dir, "i18n.config.json"), {} as { context?: string; keep?: string[] });
  const snapPath = join(dir, ".en-snapshot.json");
  console.log(`${dir}: ${Object.keys(source).length} English strings`);
  missing += await sync(source, readJson(snapPath, {}), (l) => readJson(join(dir, `${l}.json`), {}), (l, c) => writeJson(join(dir, `${l}.json`), c), config);
  if (!args.check) {
    writeJson(snapPath, source);
    if (args.bundle) {
      const all: Record<string, Catalog> = { en: source };
      // Every language on disk, not just this run's --locales, so partial runs never drop one.
      for (const { code } of LOCALES) if (code !== "en" && existsSync(join(dir, `${code}.json`))) all[code] = readJson(join(dir, `${code}.json`), {});
      mkdirSync(dirname(args.bundle), { recursive: true });
      writeFileSync(args.bundle, `// Generated by @infinitum/i18n (scripts/translate.ts). Do not edit; edit en.json and re-run.\nexport default ${JSON.stringify(all, null, 1)};\n`);
      console.log(`  bundle: ${args.bundle}`);
    }
  }
}

if (args.android) {
  const res = args.android;
  const base = readAndroidStrings(readFileSync(join(res, "values", "strings.xml"), "utf8"));
  const config = readJson(join(res, "..", "i18n.config.json"), {} as { context?: string; keep?: string[] });
  const snapPath = join(res, "..", "i18n-snapshot.json");
  console.log(`${res}: ${Object.keys(base).length} Android strings`);
  missing += await sync(
    base, readJson(snapPath, {}),
    (l) => { const p = join(res, androidLocaleDir(l), "strings.xml"); return existsSync(p) ? readAndroidStrings(readFileSync(p, "utf8")) : {}; },
    (l, c) => { const p = join(res, androidLocaleDir(l), "strings.xml"); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, writeAndroidStrings(c)); },
    config,
  );
  if (!args.check) {
    writeJson(snapPath, base);
    const cfg = `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by @infinitum/i18n. Lets Android 13+ pick this app's language in system settings. -->\n<locale-config xmlns:android="http://schemas.android.com/apk/res/android">\n${["en", ...targets].map((l) => `    <locale android:name="${l === "zh" ? "zh-CN" : l === "pt" ? "pt-BR" : l}" />`).join("\n")}\n</locale-config>\n`;
    mkdirSync(join(res, "xml"), { recursive: true });
    writeFileSync(join(res, "xml", "locales_config.xml"), cfg);
  }
}

if (args.chrome) {
  const dir = args.chrome;
  type Messages = Record<string, { message: string; description?: string }>;
  const en: Messages = readJson(join(dir, "en", "messages.json"), {});
  const source: Catalog = Object.fromEntries(Object.entries(en).map(([k, v]) => [k, v.message]));
  const snapPath = join(dir, "..", ".chrome-i18n-snapshot.json");
  console.log(`${dir}: ${Object.keys(source).length} extension strings`);
  missing += await sync(
    source, readJson(snapPath, {}),
    (l) => Object.fromEntries(Object.entries(readJson(join(dir, chromeLocaleDir(l), "messages.json"), {} as Messages)).map(([k, v]) => [k, v.message])),
    (l, c) => writeJson(join(dir, chromeLocaleDir(l), "messages.json"),
      Object.fromEntries(Object.entries(c).map(([k, m]) => [k, en[k]?.description ? { message: m, description: en[k].description } : { message: m }]))),
    readJson(join(dir, "..", "i18n.config.json"), {}),
  );
  if (!args.check) writeJson(snapPath, source);
}

if (args.check && missing) { console.error(`${missing} translation(s) missing; run without --check to generate them.`); process.exit(1); }
