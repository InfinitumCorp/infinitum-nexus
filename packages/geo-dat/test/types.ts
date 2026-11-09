import { createGeoHook, resolveGeoEnabled } from "../src/index.js";
import { applyGeoCli } from "../src/node.js";

const hook = createGeoHook({ enabled: false });
const enabled: boolean = resolveGeoEnabled({ stored: null, env: {} });
const saved: boolean = applyGeoCli({ argv: ["node"] }).enabled;
void hook.lookupCountry("127.0.0.1");
void enabled;
void saved;
