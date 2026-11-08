import type { Config } from "@/configuration";
import type { McpManager } from "@/mcp/McpManager";
import { mcpDisabledByEnv } from "@/mcp/mcpEnv";
import type { SkillRegistry } from "@/skills";
import { logger } from "@/utils/logger";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { ShellTool } from "./shell";
import { SpawnTool } from "./spawn";
import { ToolRegistry } from "./ToolRegistry";
import { UseSkillTool } from "./useSkill";
import { WriteFileTool } from "./writeFile";

interface ToolRegistryWiring {
  // Loaded skills, when the session has any. Enables the use_skill tool.
  skills?: SkillRegistry;
  // Owner of the MCP connections, when the session has any. Enables the
  // mcp__<server>__<tool> tools.
  mcp?: McpManager;
}

// Builds the registry wired with the tools enabled for this harness version.
// When allowedTools is given, only those tools are registered; an empty list
// disables tools entirely.
//
// use_skill and the MCP tools are only offered to agents that declare no
// allowlist: an agent that lists its tools gets exactly those, so enable them on
// it by naming them in its definition instead of adding them behind its back.
//
// LIMITATION, MCP with an allowlist: naming an mcp__<server>__<tool> there works,
// but nothing warns when the name does not exist yet. The remote tools are
// discovered lazily and asynchronously, so at build time the registry cannot
// know whether the name is real; the call fails later with "Unknown tool", the
// same result as any other typo.
export const createToolRegistry = (
  config: Config,
  allowedTools?: string[],
  wiring: ToolRegistryWiring = {},
) => {
  const tools = config.config.tools;
  const skills = wiring.skills;
  const mcp = wiring.mcp;
  const skillsUsable =
    allowedTools === undefined &&
    config.config.skills?.enabled !== false &&
    (skills?.list().length ?? 0) > 0;
  const mcpUsable =
    allowedTools === undefined && config.config.mcp?.enabled === true && !mcpDisabledByEnv();

  const all = [
    new ShellTool({
      timeoutMs: tools?.shell?.timeoutMs,
      maxOutputBytes: tools?.shell?.maxOutputBytes,
    }),
    new ReadFileTool(),
    new WriteFileTool({ deny: tools?.writeDeny }),
    new ListDirTool(),
    new SpawnTool(),
    ...(skillsUsable ? [new UseSkillTool()] : []),
  ];

  if (allowedTools !== undefined) {
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
  }

  const registry = new ToolRegistry(all, { maxOutputBytes: tools?.maxOutputBytes });

  // The manager never knows the native tools: they are handed over so a remote
  // tool can never shadow one of them.
  if (mcpUsable && mcp) {
    const occupied = new Set(all.map((tool) => tool.name));
    registry.addProvider(() => mcp.tools(occupied));
  }

  return registry;
};

export { ToolRegistry, UseSkillTool };
export type { ToolProvider, ToolRegistryOptions } from "./ToolRegistry";
export type { ToolRegistryWiring };
export type {
  ApprovalDecision,
  ApprovalRequest,
  SpawnRequestResult,
  Tool,
  ToolContext,
  ToolResult,
} from "./Tool";
