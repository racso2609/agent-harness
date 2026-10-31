import type { Config } from "@/configuration";
import { logger } from "@/utils/logger";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { ShellTool } from "./shell";
import { ToolRegistry } from "./ToolRegistry";
import { WriteFileTool } from "./writeFile";

// Builds the registry wired with the tools enabled for this harness version.
// When allowedTools is given, only those tools are registered; an empty list
// disables tools entirely.
export const createToolRegistry = (
  config: Config,
  allowedTools?: string[],
) => {
  const tools = config.config.tools;
  const all = [
    new ShellTool({
      timeoutMs: tools?.shell?.timeoutMs,
      maxOutputBytes: tools?.shell?.maxOutputBytes,
    }),
    new ReadFileTool(),
    new WriteFileTool({ deny: tools?.writeDeny }),
    new ListDirTool(),
  ];

  if (allowedTools === undefined) {
    return new ToolRegistry(all, { maxOutputBytes: tools?.maxOutputBytes });
  }

  const allowed = new Set(allowedTools);
  for (const name of allowed) {
    if (!all.some((tool) => tool.name === name)) {
      logger.warn(`Agent requested unknown tool: ${name}`);
    }
  }

  return new ToolRegistry(
    all.filter((tool) => allowed.has(tool.name)),
    { maxOutputBytes: tools?.maxOutputBytes },
  );
};

export { ToolRegistry };
export type {
  ApprovalDecision,
  ApprovalRequest,
  Tool,
  ToolContext,
  ToolResult,
} from "./Tool";
