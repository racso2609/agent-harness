import type { Config } from "@/configuration";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { ShellTool } from "./shell";
import { ToolRegistry } from "./ToolRegistry";
import { WriteFileTool } from "./writeFile";

// Builds the registry wired with the tools enabled for this harness version.
export const createToolRegistry = (config: Config) => {
  const tools = config.config.tools;

  return new ToolRegistry(
    [
      new ShellTool({
        timeoutMs: tools?.shell?.timeoutMs,
        maxOutputBytes: tools?.shell?.maxOutputBytes,
      }),
      new ReadFileTool(),
      new WriteFileTool(),
      new ListDirTool(),
    ],
    { maxOutputBytes: tools?.maxOutputBytes },
  );
};

export { ToolRegistry };
export type { Tool, ToolContext, ToolResult } from "./Tool";
