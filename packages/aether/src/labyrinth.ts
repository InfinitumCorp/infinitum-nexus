import { createLabyrinthClient } from "@infinitum/lbrnth-client";
import type { LabyrinthClientOptions } from "@infinitum/lbrnth-client";

/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createAetherLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("aether", options);
