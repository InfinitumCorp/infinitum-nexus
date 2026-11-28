import { Type } from "typebox";
import type { Static } from "typebox";
import { DEFAULT_ENDPOINT, LabyrinthTools } from "./labyrinth.ts";
import type { LabyrinthSettings } from "./labyrinth.ts";

export const PLUGIN_ID = "labyrinth";
export const PLUGIN_NAME = "Labyrinth";
export const PLUGIN_DESCRIPTION = "Read and save files in your private Labyrinth repositories (Infinitum Corporation), signed in with Cumulus ID.";

export const configSchema = Type.Object({
  endpoint: Type.Optional(Type.String({
    description: `Labyrinth relay (https only). Default ${DEFAULT_ENDPOINT}; in Russia use https://ru.id.cumuluscloud.app/api/labyrinth.`,
  })),
  token: Type.Optional(Type.String({
    description: "Repository-only lbrnth_ credential from id.cumuluscloud.app/labyrinth (lasts 15 minutes). Prefer the LBRNTH_TOKEN environment variable or a SecretRef.",
  })),
}, { additionalProperties: false });

const repo = Type.String({ description: "Repository name or id, as listed by labyrinth_repositories." });
const branch = Type.Optional(Type.String({ description: "Branch name. Default main." }));
const path = Type.String({ description: "File path inside the OpenClaw folder of the repository, for example notes/today.md." });

const listParams = Type.Object({}, { additionalProperties: false });
const readParams = Type.Object({ repo, path, branch }, { additionalProperties: false });
const historyParams = Type.Object({
  repo, branch,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "How many versions. Default 20." })),
}, { additionalProperties: false });
const saveParams = Type.Object({
  repo, path, branch,
  content: Type.String({ description: "Full new file content (text, up to 1 MiB)." }),
  message: Type.Optional(Type.String({ description: "Short description of the change." })),
}, { additionalProperties: false });

type Settings = LabyrinthSettings;
type Context = { signal?: AbortSignal };

/** Tool definitions in the shape `defineToolPlugin`'s `tool()` accepts. Kept SDK-free for tests. */
export function labyrinthToolDefinitions(make: (settings: Settings) => LabyrinthTools = settings => new LabyrinthTools(settings)) {
  return [
    {
      name: "labyrinth_repositories",
      label: "Labyrinth: list repositories",
      description: "List the person's private Labyrinth repositories with their branches.",
      parameters: listParams,
      workspaceAccess: false as const,
      execute: (_params: Static<typeof listParams>, config: Settings, context?: Context) => make(config).repositories(context?.signal),
    },
    {
      name: "labyrinth_read",
      label: "Labyrinth: read a file",
      description: "Read a text file this agent saved earlier in a Labyrinth repository (the latest version on a branch).",
      parameters: readParams,
      workspaceAccess: false as const,
      execute: (p: Static<typeof readParams>, config: Settings, context?: Context) => make(config).read(p.repo, p.path, p.branch, context?.signal),
    },
    {
      name: "labyrinth_history",
      label: "Labyrinth: version history",
      description: "List recent versions of a Labyrinth branch, with the agent's files in each version.",
      parameters: historyParams,
      workspaceAccess: false as const,
      execute: (p: Static<typeof historyParams>, config: Settings, context?: Context) => make(config).history(p.repo, p.branch, p.limit, context?.signal),
    },
    {
      name: "labyrinth_save",
      label: "Labyrinth: save a file",
      description: "Save a text file as a new version in a Labyrinth repository. Earlier versions are kept. Files go under the repository's OpenClaw folder only.",
      parameters: saveParams,
      // Writes need the person's explicit allowlist in OpenClaw.
      optional: true,
      workspaceAccess: false as const,
      execute: (p: Static<typeof saveParams>, config: Settings, context?: Context) => make(config).save(p.repo, p.path, p.content, p.message, p.branch, context?.signal),
    },
  ] as const;
}

export const TOOL_NAMES = labyrinthToolDefinitions().map(t => t.name);
