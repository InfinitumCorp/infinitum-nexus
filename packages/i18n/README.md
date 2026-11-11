# @infinitum/i18n

Every Infinitum app shows its interface in the visitor's language. Languages: English (source and fallback), Russian, Ukrainian, Spanish, French, German, Portuguese, Chinese (Simplified) and Arabic (right to left).

**Nothing is translated at runtime.** Catalogs are generated at build time with the open-weight models behind `@infinitum/ai` and committed with each app. Apps keep working offline and in Russia without a VPN, where Cloudflare, Vercel and Supabase time out. The UI never calls a model host.

## How an app gets its language

1. A choice the visitor made in the language menu, remembered in `localStorage["infinitum.lang"]`. The same key works in every app.
2. `?lang=ru` in the URL.
3. The browser's preferred languages (`navigator.languages`).
4. English.

`<html lang dir>` follows the language. Arabic sets `dir="rtl"`.

## Runtime (`src/i18n.js`)

`src/i18n.js` is a single dependency-free ES module. It runs the same in Vite/React, static pages, Workers-served pages and Chrome extensions.

```js
import { startI18n } from "./i18n.js";
import catalogs from "./i18n-catalogs.js";              // generated
const i18n = startI18n({ catalogs, switcher: "#lang-switch" });
```

`startI18n` detects the language and translates the rendered page. It keeps watching, so text that views render later is translated too. It mounts the language menu into `switcher`. The menu is a plain `<select class="lang-switch">` styled by `src/i18n.css`: white and black with a hairline border, no images, so it passes strict CSPs.

- **Catalog keys are the English text.** `scripts/extract.ts` finds UI strings in the source, so an app needs no code changes to be translated.
- **Patterns.** Template-literal and JSX expressions become `{0}`, `{1}`… placeholders. For example, `"{0} / {1} active agents"` matches the rendered text "3 / 5 active agents".
- **Opting out.** Text inside `translate="no"`, `contenteditable`, `<code>`, `<pre>` and `<textarea>` is never touched. Mark user content with `translate="no"`: mail bodies, chat, AI output, task titles.
- **Explicit API.** `i18n.t("Key", { n: 3 })`, `i18n.lookup(text)`, `i18n.setLocale("ar" | null)` and `i18n.subscribe(fn)` are available when code builds strings itself. For React, `src/react.js` provides `useI18n(i18n)`.
- **`data-i18n` attributes.** `data-i18n="key"` and `data-i18n-attr="placeholder:key"` work for hand-keyed markup through `i18n.apply(root)`.

## Generate catalogs

From the repo root (`infinitum-nexus`):

```bash
# 1. Find UI strings (re-run after UI changes; vanished strings are pruned)
node --experimental-strip-types packages/i18n/scripts/extract.ts --out <app>/i18n <app>/public

# 2. Translate new or changed strings and write the bundle the app imports
node --experimental-strip-types packages/i18n/scripts/translate.ts --dir <app>/i18n --bundle <app>/public/i18n-catalogs.js

# CI-style check: fails if any language is missing strings
node --experimental-strip-types packages/i18n/scripts/translate.ts --dir <app>/i18n --check
```

Step 2 accepts other source formats in place of `--dir` and `--bundle`:

- `--android <res dir>` reads `values/strings.xml`. It writes `values-ru/`, `values-zh-rCN/`, `values-pt-rBR/` and the other locale folders, plus `xml/locales_config.xml`, so Android 13+ lists the app under per-app language settings.
- `--chrome <_locales dir>` reads `en/messages.json` and writes `ru/`, `zh_CN/`, `pt_BR/` and the other locales.

Translation is incremental. `.en-snapshot.json` records the English text each language was translated from. Only new or changed strings go to the model.

Each translation is checked to keep its `{placeholders}` and HTML tags. A failed string is retried. A string that still fails stays in English and is reported.

`<app>/i18n/i18n.config.json` can hold `context` (one sentence about the product) and `keep`, a list of names never to translate, such as `SCALVS.ai`, `Cumulus://Mail` or `$SCLV`.

### Models

The script uses `sharedRouter()` from `@infinitum/ai`, so OmniRoute is tried first, then any other configured hosts. Only open-weight models are used. This is the setup used for the committed catalogs:

```bash
AI_PROVIDER_ORDER=omniroute,self \
OMNIROUTE_SMART_MODEL=ddgw/tinfoil/gpt-oss-120b \
AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=gpt-oss:20b \
node --experimental-strip-types packages/i18n/scripts/translate.ts ...
```

The local Ollama fallback needs a context of at least 8k tokens. Ollama's default is 4k. Create a variant with `PARAMETER num_ctx 8192` in a Modelfile.

## User content (`src/content.ts`)

`translateContent(text, "ru")` translates mail bodies, chat and AI output on demand. It runs on the server through `@infinitum/ai`, and the browser asks its own backend for it. Instructions inside the text are never followed. UI strings never use this path.

## Copies

Static apps serve the runtime from `public/`. `copies.json` lists every copy in this repo. Run `pnpm --filter @infinitum/i18n sync` after editing `src/`, and the package test fails if a copy drifts.

Standalone repos vendor `i18n.js` and `i18n.css` in `src/i18n/` and re-copy them by hand. Those repos are scalvs-ai, cumulus-mail, cumulus-exchange, architect, Conjure, eidetic and infinitum-academy.
