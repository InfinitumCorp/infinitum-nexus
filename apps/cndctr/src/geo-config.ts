import { join } from "node:path";
import { applyGeoCli } from "@infinitum/geo-dat/node";

/** Saved under the data directory. Missing file and no flag means off. */
export function loadGeoRouting(dataDir: string, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv) {
  return applyGeoCli({ path: join(dataDir, "geo-routing.json"), env, argv });
}
