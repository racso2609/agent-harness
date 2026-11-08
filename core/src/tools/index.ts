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
// use_skill is only offered to agents that declare no allowlist, and so is any
// MCP tool an allowlist does not name. An agent that lists its tools gets
// exactly those: an mcp__<server>__<tool> it names is resolved, the rest of the
// server stays out.
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
  // Three independent gates: no allowlist (option A: an agent that lists its tools
  // gets exactly those and nothing else), mcp.enabled in the config, and the
  // environment kill-switch. Any of them off and the manager is never asked.
  const mcpUsable = config.config.mcp?.enabled === true && !mcpDisabledByEnv();

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

  const registry = new ToolRegistry(all, { maxOutputBytes: tools?.maxOutputBytes });

  // The manager never knows the native tools: they are handed over so a remote
  // tool can never shadow one of them.
  if (mcpUsable && mcp) {
    const occupied = new Set(all.map((tool) => tool.name));
    registry.addProvider(() => mcp.tools(occupied));
  }

  if (allowedTools !== undefined) {
    const allowed = new Set(allowedTools);
    for (const name of allowed) {
      // An mcp__ name is not native: only warn when MCP is off, so naming a
      // remote tool in an agent definition does not warn on every build.
      if (mcpUsable && name.startsWith("mcp__")) continue;
      if (!all.some((tool) => tool.name === name)) {
        logger.warn(`Agent requested unknown tool: ${name}`);
      }
    }

    const registry = new ToolRegistry(
      all.filter((tool) => allowed.has(tool.name)),
      { maxOutputBytes: tools?.maxOutputBytes },
    );

    // Option A: the allowlist is the whole list, so the native tools are the only
    // ones it can offer. The provider is installed anyway, which is what lets a
    // named mcp__<server>__<tool> resolve while every other remote tool stays
    // out: the lookup goes through `registry.get()` by name.
    if (mcpUsable && mcp) {
      const occupied = new Set(all.map((tool) => tool.name));
      registry.addProvider(() => mcp.tools(occupied).filter((tool) => allowed.has(tool.name)));
    }

    return registry;
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
