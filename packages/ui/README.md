# @infinitum/ui — the shared app shell

One layout for every Infinitum product app. Built from `RULES/BUILD_RULES.md` and `RULES/brand/infinitum.css`.

- **`app-shell.css`** — the tokens (paper `#ffffff`, ink `#111820`, muted, line, accent `#2454dd`), the system Helvetica stack, weight-400 headings, hairline rules, and the shell and components below. No gradients, shadows, glows or decorative color. The accent is for focus and hover only.
- **`shell.html`** — reference markup. Copy its structure.

## Layout

```html
<a class="skip-link" href="#main">Skip to content</a>
<header class="app-bar">
  <a class="app-wordmark" href="/">+SPCTR<sup class="tm">™</sup></a>
  <nav class="app-nav" aria-label="Main">
    <a href="/" aria-current="page">Home</a>
  </nav>
  <div class="app-actions">…</div>
</header>
<main id="main" class="app-main">…</main>
<footer class="app-footer">…</footer>
```

| Class | Use |
|---|---|
| `.app-bar` | Sticky top bar, hairline below |
| `.app-wordmark` | The product's own wordmark, left. Never the Infinitum logo |
| `.app-nav` | Main navigation. Mark the current page with `aria-current="page"` (or `.active`) |
| `.app-actions` | Right-aligned account and sign-out controls |
| `.app-main` | Content column, 1120px max (`.wide` for full width) |
| `.app-head` | Page title row with an optional primary action |
| `.app-section` | Section separated by a hairline |
| `.app-footer` | Legal text. May name the company as text; no logo images |
| `.btn`, `.btn.primary`, `.btn.ghost`, `.btn.small` | Buttons (also `.btn-primary`, `.btn-secondary`) |
| `.field`, `.input` | Labels and inputs |
| `.table` | Data tables |
| `.notice` | Status and error notices (monochrome) |
| `.empty` | Empty states |
| `.rows` | Hairline-separated lists |

## Wordmarks

Write each product name exactly as `RULES/brand/wordmarks.md` gives it, followed by `<sup class="tm">™</sup>`: `:\ARCHITECT\`, `+SPCTR`, `Cumulus://Mail`, `ODIN°`, `FABRIC`, `VEIL&lt;/&gt;`, `SCALVS.ai`, `E(O)N`, `ÆTHER`, `[HRVST]`, `ei·det·ic`. Inside JS/TS string literals and JSON, double each backslash (`":\\ARCHITECT\\"`). No ™ in `<title>`.

## Using it

Static apps in this repo keep a vendored copy next to their other public files, listed in `copies.json`. After changing `app-shell.css`:

```bash
npx -y pnpm@10.28.0 --filter @infinitum/ui sync
```

The test fails if any copy differs from `app-shell.css`. Standalone repos mirror the same file (for example `public/app-shell.css`); copy it from here rather than writing per-app styles. Load it before the app's own stylesheet.
