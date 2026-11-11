import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const olc = require(join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../third_party/google-open-location-code/openlocationcode.js",
)) as {
  encode(latitude: number, longitude: number, codeLength?: number): string;
  isValid(code: string): boolean;
};

/** Plus code from Google's Open Location Code. A 10-character code is about 14 m on a side. */
export function plusCode(lat: number, lon: number, length = 10): string {
  const code = olc.encode(lat, lon, length);
  if (!olc.isValid(code)) throw new Error("Open Location Code rejected this position.");
  return code;
}
