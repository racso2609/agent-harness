import { logger } from "@/utils/logger";
import { sanitizeServerId } from "./mcpNaming";

// Transport used to reach a server. Only stdio exists today; the field is
// there so configs written now keep working when http lands.
export type McpTransportName = "stdio";

// One MCP server, keyed by a free-form id in `mcp.servers`.
export interface McpServerConfig {
  // Defaults to "stdio".
  transport?: McpTransportName;
  // Executable spawned for a stdio server. Must be the bare program name:
  // extra arguments belong in `args`.
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // Lets the user keep a definition around without starting it.
  enabled?: boolean;
  // Untrusted servers keep their tools hidden unless approved; reserved for
  // the approval phase.
  untrusted?: boolean;
  // Human-readable summary shown in listings.
  description?: string;
}

export interface McpConfig {
  // Master switch. Off by default: MCP starts no processes unless asked to.
  enabled?: boolean;
  servers?: Record<string, McpServerConfig>;
  // Cap applied to each remote tool description.
  maxDescriptionChars?: number;
  // Cap for the tool index injected in the system prompt.
  maxToolsIndexChars?: number;
  // Budget for spawning a server and completing the handshake.
  startupTimeoutMs?: number;
  // Budget for a single tools/call round trip.
  callTimeoutMs?: number;
  // Cap on in-flight tools/call requests.
  maxConcurrentCalls?: number;
}

// The slice of the harness config that `resolveMcpServers` reads.
interface McpConfigSource {
  mcp?: McpConfig;
}

// A server definition that passed validation, with every default applied.
export interface ResolvedMcpServer {
  id: string;
  transport: McpTransportName;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  untrusted: boolean;
  description?: string;
}

const SUPPORTED_TRANSPORTS: McpTransportName[] = ["stdio"];

// Programs that are usually written as `npx -y @scope/server` in other MCP
// clients. Only for them is "move the rest into args" the right advice.
const LAUNCHER_COMMANDS = new Set(["npx", "pnpm", "node", "uvx", "python", "deno", "bun"]);

// Debug rendering for invalid values. `JSON.stringify` throws on BigInt and on
// circular structures, and these warns run during boot: a broken config must
// never take the process down with it.
const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

// Builds the resolved server for one config entry, or returns the reason why
// it must be skipped. Invalid entries never throw: they are logged and left
// out so a typo cannot break the boot.
const resolveServer = (
  id: string,
  raw: McpServerConfig,
): { server: ResolvedMcpServer } | { reason: string } => {
  const serverId = sanitizeServerId(id);
  if (!serverId) {
    return { reason: `MCP server id "${id}" has no usable characters` };
  }

  if (!raw || typeof raw !== "object") return { reason: `MCP server "${id}" is not an object` };
  if (raw.enabled === false) return { reason: `MCP server "${id}" is disabled` };

  const transport = raw.transport ?? "stdio";
  if (!SUPPORTED_TRANSPORTS.includes(transport)) {
    return { reason: `MCP server "${id}" uses an unsupported transport: ${transport}` };
  }

  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command) return { reason: `MCP server "${id}" is missing a command` };

  // `{ command: "npx -y @scope/server" }` is the usual copy-paste mistake from
  // other clients; accepted as is, it would only fail at spawn time with an
  // opaque ENOENT. A command with spaces is not always that mistake: a path such
  // as "/Applications/My App/bin/server" is one executable, and telling the user
  // to move its path into args would be wrong.
  const [program, ...embeddedArgs] = command.split(/\s+/);
  if (embeddedArgs.length > 0) {
    const advice = LAUNCHER_COMMANDS.has(program.toLowerCase())
      ? `move "${embeddedArgs.join(" ")}" into args`
      : "executables whose path contains spaces are not supported yet; point command at an executable without spaces and pass the real path through args";

    return {
      reason: `MCP server "${id}" command must be the bare executable; ${advice}`,
    };
  }

  if (raw.args !== undefined && !Array.isArray(raw.args)) {
    return { reason: `MCP server "${id}" args must be an array of strings` };
  }

  const args: string[] = [];
  for (const [index, arg] of (raw.args ?? []).entries()) {
    if (typeof arg === "string") {
      args.push(arg);
      continue;
    }

    logger.warn(
      `MCP server "${id}" args[${index}] is not a string and was dropped: ${safeStringify(arg)}`,
    );
  }

  if (
    raw.env !== undefined &&
    (!raw.env || typeof raw.env !== "object" || Array.isArray(raw.env))
  ) {
    return { reason: `MCP server "${id}" env must be an object of strings` };
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.env ?? {})) {
    if (typeof value === "string") {
      env[key] = value;
      continue;
    }

    logger.warn(
      `MCP server "${id}" env ${key} is not a string and was dropped: ${safeStringify(value)}`,
    );
  }

  return {
    server: {
      id: serverId,
      transport,
      command,
      args,
      env,
      ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
      untrusted: raw.untrusted === true,
      ...(typeof raw.description === "string" && raw.description
        ? { description: raw.description }
        : {}),
    },
  };
};

// Returns the servers that can actually be started, with defaults applied.
// Disabled servers (master switch or per-server flag) yield an empty list,
// and every discarded entry is reported once through logger.warn.
// Order follows the config object so the registry stays deterministic.
export function resolveMcpServers(config: McpConfigSource): ResolvedMcpServer[] {
  const mcp = config.mcp;
  if (!mcp || mcp.enabled === false) return [];

  const servers = mcp.servers ?? {};
  const resolved: ResolvedMcpServer[] = [];
  // Sanitized ids can still clash when the raw ids differ only in characters
  // that are not allowed ("GitHub Cloud" and "github_cloud"); the first one
  // listed wins so the registry never holds duplicates.
  const seen = new Set<string>();

  for (const [id, raw] of Object.entries(servers)) {
    const outcome = resolveServer(id, raw);
    if ("reason" in outcome) {
      logger.warn(outcome.reason);
      continue;
    }

    if (seen.has(outcome.server.id)) {
      logger.warn(
        `MCP server "${id}" collides with an earlier server on id "${outcome.server.id}"`,
      );
      continue;
    }

    seen.add(outcome.server.id);
    resolved.push(outcome.server);
  }

  return resolved;
}
