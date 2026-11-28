import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { serveNodeLabyrinthUI } from "./ui.ts";
import { UI_ASSETS } from "./ui-assets.generated.ts";
import { uiAssetsModule } from "./ui-assets-source.ts";

const lf = (s: string) => s.replace(/\r\n/g, "\n");

test("embedded Labyrinth page matches public/ (run scripts/ui-assets.ts if this fails)", () => {
  assert.equal(lf(readFileSync(new URL("./ui-assets.generated.ts", import.meta.url), "utf8")), uiAssetsModule());
  for (const name of ["index.html", "app.js", "style.css"] as const) {
    assert.equal(UI_ASSETS[name], lf(readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8")));
  }
});

test("the page is served from memory, so it works on Workers without a filesystem", async () => {
  assert.equal(/node:fs/.test(readFileSync(new URL("./ui.ts", import.meta.url), "utf8")), false);
  const server = createServer((req, res) => void serveNodeLabyrinthUI(req, res, "cumulus-mail"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const page = await fetch(`${base}/labyrinth`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-product="cumulus-mail"/);
    for (const [path, type] of [["/labyrinth/assets/app.js", "text/javascript"], ["/labyrinth/assets/style.css", "text/css"]]) {
      const r = await fetch(base + path);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", new RegExp(type));
    }
    assert.equal((await fetch(`${base}/labyrinth/assets/missing.js`)).status, 404);
  } finally { server.close(); }
});
