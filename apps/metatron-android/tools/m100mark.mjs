// Tight-cropped METATRON¹⁰⁰™ mark (black glyph, transparent) for the THRONE][OS launcher, from the icon path.
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
const [vector, out, hPx] = process.argv.slice(2);
const d = readFileSync(vector, "utf8").match(/pathData="([^"]+)"/)[1];
const n = d.match(/-?\d+\.?\d*/g).map(Number);
const xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys), pad = 0.6;
const vb = `${x1 - pad} ${y1 - pad} ${x2 - x1 + 2 * pad} ${y2 - y1 + 2 * pad}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#000000"/></svg>`;
writeFileSync(out, new Resvg(svg, { fitTo: { mode: "height", value: Number(hPx) } }).render().asPng());
console.log("ok", vb);
