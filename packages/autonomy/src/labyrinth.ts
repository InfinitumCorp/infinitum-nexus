import { createLabyrinthClient } from "@infinitum/lbrnth-client";
import type { LabyrinthClientOptions } from "@infinitum/lbrnth-client";

/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createDaemonLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("daemon", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createSlugLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("slug", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createFlowerLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("flower", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createOrbisLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("orbis", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createPollenLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("pollen", options);
