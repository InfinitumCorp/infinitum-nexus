// Subset of `openclaw/plugin-sdk/tool-plugin` (openclaw 2026.11.3) used to typecheck this package
// without installing OpenClaw (275 MB) into the monorepo. At runtime the real SDK is the host's.
declare module "openclaw/plugin-sdk/tool-plugin" {
  import type { Static, TSchema } from "typebox";
  export type ToolPluginExecutionContext = { signal?: AbortSignal; toolCallId: string };
  type Config<C> = C extends TSchema ? Static<C> : Record<string, never>;
  export type ToolDefinition<C, P extends TSchema> = {
    name: string; label?: string; description: string; parameters: P; optional?: boolean; workspaceAccess?: boolean | "execute";
    execute: (params: Static<P>, config: C, context: ToolPluginExecutionContext) => unknown;
  };
  export type DefinedToolPluginTool = { name: string };
  export function defineToolPlugin<C extends TSchema | undefined = undefined>(definition: {
    id: string; name: string; description: string; configSchema?: C;
    tools: (tool: <P extends TSchema>(definition: ToolDefinition<Config<C>, P>) => DefinedToolPluginTool) => readonly DefinedToolPluginTool[];
  }): unknown;
}
