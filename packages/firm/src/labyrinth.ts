import { createLabyrinthClient } from "@infinitum/lbrnth-client";
import type { LabyrinthClientOptions } from "@infinitum/lbrnth-client";

/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createFirmLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("firm", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createFirmWalletLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("firm-wallet", options);
/** Explicit user-selected artifact save/load; live CID session and org entitlement are checked by the service. */
export const createTokensLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("tokens", options);
