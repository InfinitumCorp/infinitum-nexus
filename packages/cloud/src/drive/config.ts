import { DriveError } from "./errors.ts";
import { assertLocalDriver } from "./s3-driver.ts";

export interface DriveConfig {
  driver: "local";
  dataDir: string;
  databaseUrl: string;
  host: string;
  port: number;
  maxUploadBytes: number;
  partSize: number;
  chunkSize: number;
  rateLimit: number;
  rateWindowMs: number;
}

/**
 * Reads Drive settings. The storage driver defaults to the local filesystem.
 * S3 is rejected here, and this function does not read object-storage credentials.
 */
export function readDriveConfig(env: NodeJS.ProcessEnv, defaults?: { dataDir?: string }): DriveConfig {
  const driver = assertLocalDriver(env.CUMULUS_CLOUD_DRIVER);
  const databaseUrl = env.CUMULUS_CLOUD_DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) throw new DriveError(500, "config", "CUMULUS_CLOUD_DATABASE_URL is required");
  const chunkSize = positiveInt(env.CUMULUS_CLOUD_CHUNK_BYTES, 64 * 1024, "CUMULUS_CLOUD_CHUNK_BYTES");
  const partSize = positiveInt(env.CUMULUS_CLOUD_PART_BYTES, 8 * 1024 * 1024, "CUMULUS_CLOUD_PART_BYTES");
  if (chunkSize > 8 * 1024 * 1024 || partSize % chunkSize !== 0) {
    throw new DriveError(500, "config", "CUMULUS_CLOUD_PART_BYTES must be a multiple of CUMULUS_CLOUD_CHUNK_BYTES");
  }
  const port = positiveInt(env.CUMULUS_CLOUD_PORT, 3020, "CUMULUS_CLOUD_PORT");
  if (port > 65535) throw new DriveError(500, "config", "CUMULUS_CLOUD_PORT is not a valid port");
  return {
    driver,
    dataDir: env.CUMULUS_CLOUD_DATA_DIR?.trim() || defaults?.dataDir || "",
    databaseUrl,
    host: env.CUMULUS_CLOUD_HOST?.trim() || "127.0.0.1",
    port,
    maxUploadBytes: positiveInt(env.CUMULUS_CLOUD_MAX_UPLOAD_BYTES, 5 * 1024 * 1024 * 1024, "CUMULUS_CLOUD_MAX_UPLOAD_BYTES"),
    partSize,
    chunkSize,
    rateLimit: positiveInt(env.CUMULUS_CLOUD_RATE_LIMIT, 120, "CUMULUS_CLOUD_RATE_LIMIT"),
    rateWindowMs: positiveInt(env.CUMULUS_CLOUD_RATE_WINDOW_MS, 60_000, "CUMULUS_CLOUD_RATE_WINDOW_MS"),
  };
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new DriveError(500, "config", `${name} must be a positive integer`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) throw new DriveError(500, "config", `${name} must be a positive integer`);
  return value;
}
