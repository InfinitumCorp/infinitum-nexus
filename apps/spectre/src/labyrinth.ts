import { createLabyrinthClient } from "@infinitum/lbrnth-client";
import type { LabyrinthClientOptions } from "@infinitum/lbrnth-client";
export const createProductLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("spectre", options);
