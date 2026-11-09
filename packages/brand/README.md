# @infinitum/brand

One brand source for every Infinitum Corporation® product UI. It matches https://infinitum-corporation.vercel.app/ exactly.

- **`brand.css`**: color tokens (`--ink`, `--muted`, `--line`, `--accent`, `--paper`), the Helvetica Neue stack, the type scale, the `.wordmark` style and the raised `sup.tm` mark.
- **`src/wordmarks.ts`**: every product wordmark as shown on the site, plus `wordmarkText(id)` (plain text with ™) and `wordmarkHtml(id)` (HTML with `<sup class="tm">™</sup>`).

## Rules

- Product logos are text wordmarks: the name in the brand font, symbols included, weight 500, ink. Never an image.
- ™ follows every product name, everywhere. The parent mark Infinitum Corporation uses ®.
- White background, one blue accent for links and focus only.

## Using it

| UI | How it gets the brand |
|---|---|
| `apps/spectre` | `public/brand.css`, linked before `app.css` |
| `apps/veil` sidebar | `brand.css` next to the HTML |
| `apps/architect` podium | inlined from this package at startup |
| `odin` repo console | copy in `src/styles/brand.css`, Tailwind tokens in `src/styles/theme.css` |

Static UIs hold copies. After editing `brand.css`, run:

```bash
pnpm brand:sync
```

`pnpm --filter @infinitum/brand test` fails if a copy is stale. The `odin` repo copy is updated by hand.
