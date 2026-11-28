// Regenerates src/ui-assets.generated.ts from public/. Run after editing public/:
//   node --experimental-strip-types packages/lbrnth/scripts/ui-assets.ts
import { writeFileSync } from "node:fs";
import { uiAssetsModule } from "../src/ui-assets-source.ts";

writeFileSync(new URL("../src/ui-assets.generated.ts", import.meta.url), uiAssetsModule());
console.log("Wrote src/ui-assets.generated.ts");
