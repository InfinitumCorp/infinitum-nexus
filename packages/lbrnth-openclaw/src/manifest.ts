import { configSchema, labyrinthToolDefinitions, PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME } from "./tools.ts";

/** The `openclaw.plugin.json` OpenClaw expects, derived from the same definitions as the runtime entry. */
export function pluginManifest(version: string) {
  const tools = labyrinthToolDefinitions();
  const optional = tools.filter(t => "optional" in t && t.optional).map(t => t.name);
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: PLUGIN_DESCRIPTION,
    version,
    configSchema: JSON.parse(JSON.stringify(configSchema)) as Record<string, unknown>,
    activation: { onStartup: true },
    contracts: { tools: tools.map(t => t.name) },
    ...(optional.length ? { toolMetadata: Object.fromEntries(optional.map(name => [name, { optional: true }])) } : {}),
  };
}
