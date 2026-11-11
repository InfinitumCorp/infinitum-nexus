import { LabyrinthHost, RemoteCidDirectory } from "@infinitum/lbrnth";
import { hostConfigFromEnv } from "./config.ts";
import { postgresDatabase } from "./pg.ts";
import { labyrinthHostServer } from "./server.ts";

const { config, missing } = hostConfigFromEnv(process.env);
let close: (() => Promise<void>) | undefined;
let host: LabyrinthHost | undefined;
if (config) {
  const database = postgresDatabase(config.databaseUrl, config.databaseCa);
  close = database.close;
  host = new LabyrinthHost({
    db: database.db,
    masterKey: config.masterKey,
    directory: new RemoteCidDirectory(config.directoryUrl, config.directoryKey),
    entitledOrgs: config.entitledOrgs,
  });
} else {
  console.warn(`Labyrinth host: /api/labyrinth answers 503 until these are set: ${missing.join(", ")}`);
}

const port = Number(process.env.PORT ?? 8080);
const server = labyrinthHostServer(host);
server.listen(port, () => console.log(`Labyrinth host listening on ${port}`));

// Cloud Run sends SIGTERM and allows 10 seconds: finish in-flight requests, then close the pool.
process.on("SIGTERM", () => {
  server.close(() => void (close?.() ?? Promise.resolve()).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 9000).unref();
});
