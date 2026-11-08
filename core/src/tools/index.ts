import type { Config } from "@/configuration";
import type { McpManager } from "@/mcp/McpManager";
import { mcpDisabledByEnv } from "@/mcp/mcpEnv";
import type { SkillRegistry } from "@/skills";
import { logger } from "@/utils/logger";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { ShellTool } from "./shell";
import { SpawnTool } from "./spawn";
import { MCP_PREFIX } from "@/mcp/mcpNaming";
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
// use_skill is only offered to agents that declare no allowlist. MCP is
// different: an agent that lists its tools gets exactly the remote names it
// names, and nothing else, because the provider filters by that list.
//
// LIMITATION, MCP with an allowlist: a named mcp__<server>__<tool> resolves only
// from the second lookup on. Discovery is lazy and asynchronous, so the first
// `specs()` of a session may be taken before the server answered; a name that
// never resolves fails with "Unknown tool", the same result as any other typo.
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
  // Two gates for the manager: mcp.enabled in the config and the environment
  // kill-switch. The allowlist does not gate it; it filters what the provider
  // offers, below.
  const mcpUsable = config.config.mcp?.enabled === true && !mcpDisabledByEnv();
  // Remote names an allowlist declared. Undefined means there is no allowlist.
  // An agent that names no MCP tool gets no provider, so discovery cannot spawn
  // a server it has no use for.
  const mcpAllowed =
    allowedTools === undefined
      ? undefined
      : new Set(allowedTools.filter((name) => name.startsWith(MCP_PREFIX)));

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

  const offered =
    allowedTools === undefined ? all : all.filter((tool) => allowedTools.includes(tool.name));
  const registry = new ToolRegistry(offered, { maxOutputBytes: tools?.maxOutputBytes });
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
  }

  // One provider, one registry, one filter. `mcpAllowed` undefined means the
  // agent declared no allowlist and gets every remote tool the manager offers; a
  // set means it gets exactly the remote names it declared, and it gets a
  // provider at all only when it declared some.
  //
  // The manager never knows the native tools: they are handed over so a remote
  // tool can never shadow one of them.
  const wantsMcp = mcpAllowed === undefined || mcpAllowed.size > 0;
  if (mcpUsable && mcp && wantsMcp) {
    const occupied = new Set(all.map((tool) => tool.name));
    registry.addProvider(() => {
      const remote = mcp.tools(occupied);
      return mcpAllowed === undefined ? remote : remote.filter((tool) => mcpAllowed.has(tool.name));
    });
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
