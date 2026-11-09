/**
 * VEIL icon: "</>" in the brand typeface (Helvetica Neue, Arial fallback) on
 * white, set like the VEIL</> wordmark (letter-spacing -0.04em). Rasterized to
 * PNG without dependencies. The glyph outlines are Arial's <, / and >, which
 * are straight-edged, embedded below in font units (2048 per em, y up).
 * Used for the web app icons and the Android launcher icons.
 */
import { deflateSync } from "node:zlib";

const INK = [17, 24, 32];      // #111820
const WHITE = [255, 255, 255];

const EM = 2048;
const TRACK = -0.04 * EM;
const GLYPHS = [
  { advance: 1196, contour: [[112, 641], [112, 809], [1083, 1219], [1083, 1040], [313, 724], [1083, 405], [1083, 226]] }, // <
  { advance: 569, contour: [[0, -25], [425, 1491], [569, 1491], [145, -25]] },                                              // /
  { advance: 1196, contour: [[1083, 641], [112, 226], [112, 405], [881, 724], [112, 1040], [112, 1219], [1083, 809]] },     // >
];

// Lay the three glyphs out, then fit them to 72% of the icon width, centred on
// the middle of < and > (y = 724), in the 256x256 icon space with y down.
const POLYS = (() => {
  const placed = []; let x = 0;
  for (const g of GLYPHS) { placed.push(g.contour.map(([gx, gy]) => [gx + x, gy])); x += g.advance + TRACK; }
  const xs = placed.flat().map((p) => p[0]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const scale = (256 * 0.72) / (maxX - minX);
  const cx = (minX + maxX) / 2;
  return placed.map((poly) => poly.map(([gx, gy]) => [128 + (gx - cx) * scale, 128 - (gy - 724) * scale]));
})();

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inRoundedRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sample(x, y) {
  if (!inRoundedRect(x, y, 256, 56)) return null;
  for (const poly of POLYS) if (inPolygon(x, y, poly)) return INK;
  return WHITE;
}

export function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((pxl + (sx + 0.5) / SS) * 256) / size, ((py + (sy + 0.5) / SS) * 256) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = (py * size + pxl) * 4;
      if (a) { px[o] = r / a; px[o + 1] = g / a; px[o + 2] = b / a; }
      px[o + 3] = Math.round((255 * a) / (SS * SS));
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
