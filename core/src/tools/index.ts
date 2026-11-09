import type { Config } from "@/configuration";
import type { McpManager } from "@/mcp/McpManager";
import { mcpDisabledByEnv } from "@/mcp/mcpEnv";
import type { SkillRegistry } from "@/skills";
import { logger } from "@/utils/logger";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { RecallTool } from "./recall";
import { ShellTool } from "./shell";
import { SpawnTool } from "./spawn";
import {
  mcpToolName,
  parseMcpToolName,
  sanitizeRemoteToolName,
  sanitizeServerId,
} from "@/mcp/mcpNaming";
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

// Maps a name written in an allowlist to the composite the manager offers.
// Hand-written names are not sanitized (`mcp__GitHub__create_issue`) while
// every tool the manager hands over is, so the two are compared in the same
// space. Anything that is not mcp__<server>__<tool> yields undefined.
//
// `mcp__Fixture_Echo__Echo` is rebuilt as `mcp__fixture_echo__echo`: the server
// id lowercases and keeps its underscores, the tool name collapses them, which
// is exactly what the manager's own names look like.
export const compositeName = (name: string): string | undefined => {
  const parts = parseMcpToolName(name);
  if (!parts) return undefined;

  // The parts come back as they were written, so they are sanitized again on the
  // way out: the composite parser only accepts lowercase [a-z0-9_] parts.
  return mcpToolName(sanitizeServerId(parts.serverId), sanitizeRemoteToolName(parts.toolName));
};

// Builds the registry wired with the tools enabled for this harness version.
// When allowedTools is given, only those tools are registered; an empty list
// disables tools entirely.
//
// use_skill and recall are only offered to agents that declare no allowlist. MCP
// is different: an agent that lists its tools gets exactly the remote names it
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
      : new Set(
          allowedTools
            .map((allow) => compositeName(allow))
            .filter((entry): entry is string => entry !== undefined),
        );
  const recallUsable =
    allowedTools === undefined &&
    config.config.memory?.enabled === true &&
    config.config.memory?.recallTool !== false;

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
    ...(recallUsable ? [new RecallTool()] : []),
  ];

  // One source for the names a remote tool must not take: every native name,
  // including the ones this agent did not ask for.
  const nativeNames = new Set(all.map((tool) => tool.name));

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
    registry.addProvider(() => {
      const remote = mcp.tools(nativeNames);
      return mcpAllowed === undefined ? remote : remote.filter((tool) => mcpAllowed.has(tool.name));
    });
  }
  return registry;
};

export { RecallTool, ToolRegistry, UseSkillTool };
export type { ToolRegistryWiring };
export type {
  ApprovalDecision,
  ApprovalRequest,
  SpawnRequestResult,
  Tool,
  ToolContext,
  ToolResult,
} from "./Tool";
