import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { configSchema, labyrinthToolDefinitions, PLUGIN_DESCRIPTION, PLUGIN_ID, PLUGIN_NAME } from "./tools.ts";

/** OpenClaw tool plugin: Labyrinth (Infinitum Corporation®) repositories for an OpenClaw agent. */
export default defineToolPlugin({
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  configSchema,
  tools: tool => {
    const [repositories, read, history, save] = labyrinthToolDefinitions();
    return [tool(repositories), tool(read), tool(history), tool(save)];
  },
});
