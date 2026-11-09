/**
 * HTTP API for the Data Exchange.
 * Run with: node --experimental-strip-types src/server.ts
 *
 * DATA_DIR (default ./data) holds exchange.json and firmament.jsonl.
 *
 * POST /datasets
 * GET  /datasets
 * POST /sell                 { datasetId, buyerId, amountUsd, licenseeAddress? }
 * GET  /sales
 * GET  /cdat
 * GET  /cdat/:tokenId        token, mint intent, and CdatLicense.mint calldata
 * GET  /payouts/:cid
 * POST /payouts/:saleId/settle
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { ConsentRequiredError, DataExchange } from "@infinitum/data-exchange";
import { FileStore, Ledger, generateSigner } from "@infinitum/firmament";

const dataDir = process.env.DATA_DIR ?? join(import.meta.dirname, "..", "data");
const ledger = new Ledger(new FileStore(join(dataDir, "firmament.jsonl")));
const signer = generateSigner();
ledger.authorize(signer.publicKey);

const dx = new DataExchange(ledger, signer, join(dataDir, "exchange.json"));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("Content-Type", "application/json");

  try {
    if (req.method === "POST" && url.pathname === "/datasets") {
      const body = JSON.parse(await readBody(req));
      try {
        const result = await dx.packageDataset(body);
        dx.catalog.updateStatus(result.dataset.id, "listed");
        await dx.flush();
        res.end(JSON.stringify(result));
      } catch (err) {
        if (err instanceof ConsentRequiredError) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: err.code }));
          return;
        }
        throw err;
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/datasets") {
      res.end(JSON.stringify(dx.listForSale()));
      return;
    }

    if (req.method === "POST" && url.pathname === "/sell") {
      const body = JSON.parse(await readBody(req));
      const sale = await dx.sell(body.datasetId, body.buyerId, body.amountUsd, body.licenseeAddress);
      if (!sale) {
        res.end(JSON.stringify({ error: "not found or not listed" }));
        return;
      }
      const token = sale.cdatTokenId ? dx.cdat.get(sale.cdatTokenId) : undefined;
      res.end(JSON.stringify({
        sale,
        cdat: token ?? null,
        calldata: token ? dx.mintCalldata(token.tokenId) ?? null : null,
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/sales") {
      res.end(JSON.stringify(dx.marketplace.listSales()));
      return;
    }

    if (req.method === "GET" && url.pathname === "/cdat") {
      res.end(JSON.stringify(dx.cdat.list()));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/cdat/")) {
      const tokenId = decodeURIComponent(url.pathname.slice("/cdat/".length));
      const token = dx.cdat.get(tokenId);
      if (!token) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.end(JSON.stringify({
        token,
        active: dx.cdat.isActive(tokenId),
        mint: dx.cdat.mintIntent(token),
        calldata: dx.mintCalldata(tokenId) ?? null,
      }));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/payouts/") && url.pathname.endsWith("/settle")) {
      const saleId = decodeURIComponent(url.pathname.slice("/payouts/".length, -"/settle".length));
      const payout = await dx.settlePayout(saleId);
      if (!payout) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "nothing to settle" }));
        return;
      }
      res.end(JSON.stringify(payout));
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/payouts/")) {
      const cid = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      res.end(JSON.stringify({
        cid,
        pendingUsd: dx.revshare.pendingForCid(cid),
        payouts: dx.revshare.listPayouts(cid),
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err) }));
  }
}

await dx.load();
const port = Number(process.env.PORT ?? 8787);
createServer(handle).listen(port, () => {
  console.log(`Data Exchange API listening on http://localhost:${port}`);
});
