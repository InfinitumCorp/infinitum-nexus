import { createLabyrinthClient } from "@infinitum/lbrnth-client";
import type { LabyrinthClientOptions } from "@infinitum/lbrnth-client";
export const createArchitectLabyrinth = (options: LabyrinthClientOptions) => createLabyrinthClient("architect", options);
