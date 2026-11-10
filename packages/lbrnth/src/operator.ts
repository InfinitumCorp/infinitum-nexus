import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { labyrinthFromEnvironment } from "./configuration.ts";
import { Labyrinth } from "./service.ts";

/** Offline maintenance only. Never imports a host's identities or grants entitlements. */
export function maintainLabyrinth(action: string, source: string, destination: string | undefined, env: Record<string, string | undefined>) {
  if (!["verify", "backup", "rotate"].includes(action)) throw new Error("Expected verify, backup or rotate");
  const input = resolve(source);
  if (action !== "verify" && (!destination || resolve(destination) === input)) throw new Error("A separate, new destination is required");
  if (destination && existsSync(resolve(destination))) throw new Error("Destination already exists; refusing to overwrite");
  const config = labyrinthFromEnvironment(env, input);
  if (!config) throw new Error("LBRNTH_MASTER_KEY is required");
  if (!existsSync(input)) throw new Error("Snapshot does not exist");
  // Stop the host first. This lock excludes cooperating writers while verifying/copying.
  const lock = `${input}.lock`;
  const fd = openSync(lock, "wx", 0o600);
  let temporary: string | undefined;
  try {
    // Constructor checks commit/object hashes, audit chain, references and capacity.
    new Labyrinth({ ...config, can: () => false, canProvision: () => false });
    const orgs = config.storage.load();
    if (action !== "verify") {
      mkdirSync(dirname(resolve(destination!)), { recursive: true, mode: 0o700 });
      temporary = join(dirname(resolve(destination!)), `.lbrnth-maintenance-${randomUUID()}`);
    }
    if (action === "backup") {
      writeFileSync(temporary!, readFileSync(input), { mode: 0o600, flag: "wx", flush: true });
      linkSync(temporary!, resolve(destination!));
    }
    if (action === "rotate") {
      if (!env.LBRNTH_NEXT_MASTER_KEY || env.LBRNTH_NEXT_MASTER_KEY === env.LBRNTH_MASTER_KEY) throw new Error("A distinct LBRNTH_NEXT_MASTER_KEY is required");
      const next = labyrinthFromEnvironment({ ...env, LBRNTH_MASTER_KEY: env.LBRNTH_NEXT_MASTER_KEY }, temporary!)!;
      next.storage.save(orgs);
      new Labyrinth({ ...next, can: () => false, canProvision: () => false });
      // Hard-link publishes without ever replacing an existing destination.
      linkSync(temporary!, resolve(destination!));
    }
    return { action, organizations: orgs.length, verified: true };
  } finally {
    closeSync(fd);
    rmSync(lock);
    if (temporary) rmSync(temporary, { force: true });
  }
}
