/**
 * VEIL brand icon (VEIL Phase I, veil-browser/branding/src/veil-icon.svg),
 * rasterized to PNG without dependencies: a white V with a slate </> above it
 * on an ink rounded square. Below 96px it uses veil-icon-small.svg (thicker V,
 * no </>), as Phase I does, so the mark stays legible on launchers.
 * Used for the web app icons and the Android launcher icons.
 */
import { deflateSync } from "node:zlib";

const INK = [17, 24, 32];      // #111820
const WHITE = [255, 255, 255];
const SLATE = [143, 163, 184]; // #8fa3b8

// Geometry in the SVGs' 256x256 viewBox: [polyline points, stroke width].
const LARGE = {
  v: [[[60, 64], [128, 196], [196, 64]], 26],
  code: [
    [[[100, 52], [84, 68], [100, 84]], 7],
    [[[156, 52], [172, 68], [156, 84]], 7],
    [[[136, 46], [120, 90]], 7],
  ],
};
const SMALL = { v: [[[58, 58], [128, 202], [198, 58]], 34], code: [] };

function segDist2(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  const ex = ax + t * dx - x, ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/** Round-capped, round-joined polyline: inside when within width/2 of any segment. */
function onStroke(x, y, [pts, width]) {
  const r2 = (width / 2) ** 2;
  for (let i = 1; i < pts.length; i++) if (segDist2(x, y, pts[i - 1], pts[i]) <= r2) return true;
  return false;
}

function inRoundedRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function sample(x, y, art) {
  if (!inRoundedRect(x, y, 256, 56)) return null;
  if (onStroke(x, y, art.v)) return WHITE;
  for (const s of art.code) if (onStroke(x, y, s)) return SLATE;
  return INK;
}

export function render(size) {
  const art = size < 96 ? SMALL : LARGE;
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(((pxl + (sx + 0.5) / SS) * 256) / size, ((py + (sy + 0.5) / SS) * 256) / size, art);
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
