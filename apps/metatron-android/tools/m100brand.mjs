// METATRON¹⁰⁰ site brand files from the Android icon path: favicon, apple-touch icon and social card (ink on white).
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";
const [vector, outDir] = process.argv.slice(2);
const d = readFileSync(vector, "utf8").match(/pathData="([^"]+)"/)[1];
const png = (vb, w, h) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}"><rect x="-500" y="-500" width="1200" height="1200" fill="#fff"/><path d="${d}" fill="#111820"/></svg>`, { fitTo: { mode: "width", value: w } }).render().asPng();
writeFileSync(`${outDir}/icon-white-bg.png`, png("23 23 62 62", 512, 512));
writeFileSync(`${outDir}/apple-touch-icon.png`, png("21 21 66 66", 180, 180));
writeFileSync(`${outDir}/og-card.png`, png("-12.5 19.1 133 69.8", 1200, 630));
console.log("ok");
