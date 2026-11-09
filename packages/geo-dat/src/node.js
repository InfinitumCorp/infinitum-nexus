/**
 * Node-only persistence for the geo-routing switch. Missing files stay off
 * and are not created unless a CLI flag asks to save the choice.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { geoFlagFromArgv, resolveGeoEnabled } from "./index.js";

export function readStoredGeo(path) {
  try {
    const body = JSON.parse(readFileSync(path, "utf8"));
    if (typeof body?.enabled === "boolean") {
      const countries = Array.isArray(body.countries) ? body.countries.map((item) => String(item)) : [];
      return { enabled: body.enabled, countries };
    }
  } catch {
    /* absent or unreadable means the switch has not been saved */
  }
  return null;
}

export function writeStoredGeo(path, enabled, countries = []) {
  mkdirSync(dirname(path), { recursive: true });
  const body = { enabled: enabled === true, countries: countries.map((item) => String(item)) };
  writeFileSync(path, `${JSON.stringify(body)}\n`);
}

export function applyGeoCli({ path, env = process.env, argv = process.argv } = {}) {
  const flag = geoFlagFromArgv(argv);
  const stored = path ? readStoredGeo(path) : null;
  const enabled = resolveGeoEnabled({ env, argv, stored: stored ? stored.enabled : null });
  if (flag.present && path) writeStoredGeo(path, enabled, stored?.countries ?? []);
  return { enabled, countries: stored?.countries ?? [] };
}
