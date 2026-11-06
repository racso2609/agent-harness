import type { Config } from "@/configuration";
import type { SkillRegistry } from "@/skills";
import { logger } from "@/utils/logger";
import { ListDirTool } from "./listDir";
import { ReadFileTool } from "./readFile";
import { RecallTool } from "./recall";
import { ShellTool } from "./shell";
import { SpawnTool } from "./spawn";
import { ToolRegistry } from "./ToolRegistry";
import { UseSkillTool } from "./useSkill";
import { WriteFileTool } from "./writeFile";

interface ToolRegistryWiring {
  // Loaded skills, when the session has any. Enables the use_skill tool.
  skills?: SkillRegistry;
}

// Builds the registry wired with the tools enabled for this harness version.
// When allowedTools is given, only those tools are registered; an empty list
// disables tools entirely.
//
// use_skill and recall are only offered to agents that declare no allowlist: an
// agent that lists its tools gets exactly those, so enable them on it by
// naming them in its definition instead of adding them behind its back.
export const createToolRegistry = (
  config: Config,
  allowedTools?: string[],
  wiring: ToolRegistryWiring = {},
) => {
  const tools = config.config.tools;
  const skills = wiring.skills;
  const skillsUsable =
    allowedTools === undefined &&
    config.config.skills?.enabled !== false &&
    (skills?.list().length ?? 0) > 0;
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
