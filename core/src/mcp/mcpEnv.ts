import { env } from "@/utils/env";

// Truthy spellings accepted for RACSO_HARNESS_MCP_DISABLED. Anything else,
// including unset, leaves MCP alone: the master switch stays mcp.enabled.
const TRUTHY = new Set(["1", "true", "yes"]);

// True when the environment switched MCP off entirely, regardless of config.
// Meant for container images and CI, where editing the config is not an option.
export const mcpDisabledByEnv = (): boolean => {
  const raw = env.RACSO_HARNESS_MCP_DISABLED?.trim().toLowerCase();
  return raw !== undefined && TRUTHY.has(raw);
};
