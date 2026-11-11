// METATRON¹⁰⁰ launcher icon: Arial Regular "M" with a raised "100" and ™, ink #111820 on white.
// Usage: node m100.mjs <android-res-dir> <preview.png>
import opentype from "opentype.js";
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
const INK = "#111820", PAPER = "#FFFFFF";
const font = opentype.loadSync("C:/Windows/Fonts/arial.ttf");
const capOf = (size) => size * font.tables.os2.sCapHeight / font.unitsPerEm;
function run(text, size, x0, base) {
  const p = new opentype.Path(); let x = x0; const gs = font.stringToGlyphs(text);
  gs.forEach((g, i) => { p.extend(g.getPath(x, base, size)); x += g.advanceWidth / font.unitsPerEm * size + (i < gs.length - 1 ? -0.04 * size : 0); });
  return p;
}
// "M" at cap height 30 (same as every Infinitum glyph); "100" at 42% size, top aligned to the M's cap.
let M = 30 / capOf(1), S = M * 0.42;
const build = (k) => {
  const m = run("M", M * k, 0, 0); const mb = m.getBoundingBox();
  const sup0 = run("100", S * k, 0, 0); const sb = sup0.getBoundingBox(); const sup = run("100", S * k, -sb.x1 + mb.x2 + 0.11 * M * k, -capOf(M * k) + capOf(S * k));
  const ub = sup.getBoundingBox();
  // ™ after the raised 100, its top on the M's cap line (as in the wordmark METATRON¹⁰⁰™).
  const tm0 = run("™", S * 0.62 * k, 0, 0); const tb = tm0.getBoundingBox();
  const tm = run("™", S * 0.62 * k, -tb.x1 + ub.x2 + 0.03 * M * k, -capOf(M * k) - tb.y1);
  const p = new opentype.Path(); p.extend(m); p.extend(sup); p.extend(tm); return p;
};
let p = build(1), b = p.getBoundingBox();
if (b.x2 - b.x1 > 52) { p = build(52 / (b.x2 - b.x1)); b = p.getBoundingBox(); }
const dx = 54 - (b.x1 + b.x2) / 2, dy = 54 - (b.y1 + b.y2) / 2;
for (const c of p.commands) { for (const k of ["x", "x1", "x2"]) if (k in c) c[k] += dx; for (const k of ["y", "y1", "y2"]) if (k in c) c[k] += dy; }
const d = p.toPathData(2);
const [res, preview] = process.argv.slice(2);
const put = (f, s) => { mkdirSync(f.replace(/[\/][^\/]+$/, ""), { recursive: true }); writeFileSync(f, s); };
const vec = (fill, path) => `<?xml version="1.0" encoding="utf-8"?>
<!-- METATRON¹⁰⁰ icon: Arial Regular "M" + raised "100" + ™, ink #111820 on white (Infinitum icon style). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="${fill}" android:pathData="${path}" />
</vector>
`;
put(`${res}/drawable/ic_launcher_mark.xml`, vec(INK, d));
put(`${res}/drawable/ic_launcher_background.xml`, vec(PAPER, "M0,0h108v108h-108z"));
put(`${res}/mipmap-anydpi-v26/ic_launcher.xml`, `<?xml version="1.0" encoding="utf-8"?>
<!-- White tile with the METATRON¹⁰⁰ glyph. The monochrome layer is for themed icons. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_mark" />
    <monochrome android:drawable="@drawable/ic_launcher_mark" />
</adaptive-icon>
`);
const svg = (o, s, px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${o} ${o} ${s} ${s}"><rect width="108" height="108" fill="${PAPER}"/><path d="${d}" fill="${INK}"/></svg>`;
for (const [dn, px] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }))
  put(`${res}/mipmap-${dn}/ic_launcher.png`, new Resvg(svg(18, 72, px)).render().asPng());
put(preview, new Resvg(svg(0, 108, 432)).render().asPng());
console.log("ok", d.length, "chars");
