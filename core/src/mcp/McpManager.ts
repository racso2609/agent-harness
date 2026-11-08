import type { Tool, ToolContext, ToolResult } from "@/tools/Tool";
import { logger } from "@/utils/logger";
import {
  type McpConfig,
  type McpTransportName,
  type ResolvedMcpServer,
  resolveMcpServers,
} from "./McpConfig";
import {
  type CallToolOptions,
  McpConnection,
  type McpConnectionOptions,
  type McpConnectionStatus,
  type RawMcpTool,
} from "./McpConnection";
import { mcpToolName } from "./mcpNaming";
import { normalizeInputSchema, truncateDescription } from "./mcpSchema";

// The slice of the harness config the manager reads.
interface McpManagerConfig {
  mcp?: McpConfig;
}

// One configured server, as the UI and the logs see it. `idle` means no
// connection was attempted yet: the manager connects lazily.
export interface McpServerSummary {
  id: string;
  transport: McpTransportName;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
}

export interface McpManagerOptions {
  // Budget for spawning a server and completing the handshake.
  startupTimeoutMs?: number;
  // Budget for a single tools/call round trip.
  callTimeoutMs?: number;
  // Sink for the stderr of every server, so a crash leaves a trace.
  onStderr?: (chunk: string) => void;
  // Builds the connection of one server. Meant for tests, which need to watch
  // the connection (how many were opened, which methods were called) without the
  // manager exposing it.
  createConnection?: (server: ResolvedMcpServer, options: McpConnectionOptions) => McpConnection;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DESCRIPTION_CHARS = 300;
const DEFAULT_MAX_CONCURRENT_CALLS = 4;

// Length of the arguments preview shown in the approval prompt.
const PREVIEW_MAX_CHARS = 120;

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Side-effect class of a remote call, derived from what the server claims about
// its own tool. The hints are self-reported, so they can only ever relax the
// gate for a trusted server: an untrusted one stays "exec" whatever it
// announces.
const approvalKind = (
  untrusted: boolean,
  annotations: RawMcpTool["annotations"],
): "read" | "write" | "exec" => {
  if (untrusted) return "exec";
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === true) return "exec";

  return "write";
};

// Keys whose value is replaced by REDACTED in the preview: credentials that
// should never reach a transcript, a log or the approval prompt.
const SENSITIVE_KEY = /token|secret|passw|api[-_]?key|authorization|credential|bearer/i;
const REDACTED = "***";

// Replaces the value of every sensitive key, at the top level and one level
// down (the shapes an MCP call actually uses: a flat argument object, or a
// nested one behind a single "params"/"options" key). Arrays are walked too;
// deeper objects are serialized as they are.
//
// BEST EFFORT, not a guarantee: it only redacts the keys it recognizes, so a
// secret hidden under an innocent-looking name still reaches the preview.
const redactArgs = (args: unknown): unknown => {
  if (Array.isArray(args)) return args.map(redactArgs);

  // A JSON string the caller already stringified: parse it so its keys can be
  // inspected, and fall back to the text when it does not parse.
  if (typeof args === "string") {
    try {
      return redactArgs(JSON.parse(args));
    } catch {
      return args;
    }
  }

  if (args === null || typeof args !== "object") return args;

  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (SENSITIVE_KEY.test(key)) {
      redacted[key] = REDACTED;
    } else if (value !== null && typeof value === "object") {
      redacted[key] = redactArgs(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
};

// Short, single-line rendering of the arguments for the approval prompt: the
// full JSON is unreadable there, and control characters break the layout. The
// recognized secrets are redacted first, so truncating cannot bring them back.
const previewArgs = (args: unknown): string => {
  let text: string;
  try {
    text = JSON.stringify(redactArgs(args ?? {})) ?? String(args);
  } catch {
    // Circular or otherwise unserializable: never echo the raw object, which
    // would print whatever it holds.
    text = String(args);
  }

  const flat = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (flat.length <= PREVIEW_MAX_CHARS) return flat;

  return `${flat.slice(0, PREVIEW_MAX_CHARS - 1)}…`;
};

// Caps the calls in flight towards one server. A plain queue: no dependency,
// and the arrival order is preserved, which keeps a burst predictable.
class CallLimiter {
  private active = 0;

  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }

    this.active += 1;

    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

// Runtime state of one server: its connection, and the tools discovered
// through it.
interface ManagedServer {
  server: ResolvedMcpServer;
  connection?: McpConnection;
  tools: Tool[];
  failure?: string;
  // Discovery in flight, so a second call never opens a second connection.
  discovering?: Promise<void>;
  // Bumped by `invalidate`. A discovery that settles after a bump discards what
  // it found instead of reviving a connection the manager already forgot.
  generation: number;
  limiter: CallLimiter;
}

// Owns one connection per configured MCP server and exposes their tools to the
// agent. Nothing is spawned until `tools()`, `toolForName()` or `ready()` is
// called, and every connection can be dropped and reopened on its own
// (`invalidate`), which is what a reload needs.
//
// There is no module-level state and no cached "initialized" flag: the only
// guard against a second connection is the in-flight discovery promise, and
// `invalidate` clears it together with the connection.
export class McpManager {
  private readonly startupTimeoutMs: number;

  private readonly callTimeoutMs: number;

  private readonly maxDescriptionChars: number;

  private readonly onStderr?: (chunk: string) => void;

  private readonly createConnection: (
    server: ResolvedMcpServer,
    options: McpConnectionOptions,
  ) => McpConnection;

  private state: ManagedServer[];

  private closed = false;

  private closing?: Promise<void>;

  // Names already reported as colliding, so a repeated `tools()` call does not
  // repeat the warning.
  private readonly warnedCollisions = new Set<string>();

  constructor(config: McpManagerConfig = {}, options: McpManagerOptions = {}) {
    const mcp = config.mcp;

    this.startupTimeoutMs =
      options.startupTimeoutMs ?? mcp?.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? mcp?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.maxDescriptionChars = mcp?.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
    this.onStderr = options.onStderr;
    this.createConnection =
      options.createConnection ?? ((server, opts) => new McpConnection(server, opts));

    const maxConcurrentCalls = Math.max(1, mcp?.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS);
    this.state = resolveMcpServers(config).map((server) => ({
      server,
      tools: [],
      generation: 0,
      limiter: new CallLimiter(maxConcurrentCalls),
    }));
  }

  // One entry per configured server, with the state of its connection. Reading
  // it never starts a server: `idle` is the state of one never connected.
  servers(): McpServerSummary[] {
    return this.state.map((entry) => {
      const error = entry.failure ?? entry.connection?.lastError;

      return {
        id: entry.server.id,
        transport: entry.server.transport,
        status: entry.connection?.status ?? "idle",
        toolCount: entry.tools.length,
        ...(error ? { error } : {}),
      };
    });
  }

  // Every tool discovered so far, in config order. Servers that were never
  // connected are kicked off here, but their tools only show up on a later call:
  // this signature is synchronous and discovery is not. Callers that need the
  // tools before building a prompt await `ready()` first.
  //
  // `occupied` holds the names already taken by native tools. A remote tool whose
  // composite name is taken is skipped and logged, never renamed or overwritten:
  // the caller's tools always win. The manager does not know the native tools, so
  // the caller passes them in; `createToolRegistry` does that.
  tools(occupied: Set<string> = new Set()): Tool[] {
    const merged: Tool[] = [];
    const taken = new Set(occupied);

    for (const entry of this.state) {
      this.ensureDiscovery(entry);

      for (const tool of entry.tools) {
        if (taken.has(tool.name)) {
          this.warnCollision(tool.name);
          continue;
        }

        taken.add(tool.name);
        merged.push(tool);
      }
    }

    return merged;
  }

  // Resolves one remote tool by its composite name, connecting on demand. It does
  // not consult the native tools: the registry only asks for a name after the
  // model produced it, and a native tool of that name is resolved before this is
  // ever consulted.
  toolForName(name: string): Tool | undefined {
    for (const entry of this.state) {
      this.ensureDiscovery(entry);

      const found = entry.tools.find((tool) => tool.name === name);
      if (found) return found;
    }

    return undefined;
  }

  // Resolves once the discovery of every configured server has settled,
  // successfully or not, triggering it first. For callers that need the complete
  // tool list (the index in the system prompt) instead of whatever is ready.
  //
  // Not a one-shot guard: a server invalidated later is discovered again on the
  // next call.
  async ready(): Promise<void> {
    const pending: Promise<void>[] = [];

    for (const entry of this.state) {
      this.ensureDiscovery(entry);
      if (entry.discovering) pending.push(entry.discovering);
    }

    await Promise.all(pending);
  }

  // Closes and forgets the given server, or every server when no id is given. The
  // next `tools()`, `toolForName()` or `ready()` opens a new connection: nothing
  // about a server survives an invalidate.
  async invalidate(serverId?: string): Promise<void> {
    const targets =
      serverId === undefined
        ? this.state
        : this.state.filter((entry) => entry.server.id === serverId);

    await Promise.all(
      targets.map(async (entry) => {
        entry.generation += 1;

        const connection = entry.connection;
        entry.connection = undefined;
        entry.tools = [];
        entry.failure = undefined;

        if (connection) await connection.close();
      }),
    );
  }

  // Cuts every connection. Idempotent: the same promise is returned on every
  // call, and a closed manager never starts a server again.
  close(): Promise<void> {
    this.closing ??= this.doClose();

    return this.closing;
  }

  private async doClose(): Promise<void> {
    this.closed = true;

    const connections = this.state
      .map((entry) => entry.connection)
      .filter((connection): connection is McpConnection => connection !== undefined);

    this.state = [];

    await Promise.all(connections.map((connection) => connection.close()));
  }

  // Opens the connection and lists the tools of one server, unless that was
  // already done. A server that fails is left in `failed` and reported through
  // `servers()`: it is never retried on its own, only through `invalidate`, so a
  // dead server cannot make every `tools()` call spawn a process.
  private ensureDiscovery(entry: ManagedServer): void {
    if (this.closed || entry.connection || entry.discovering) return;

    const { generation } = entry;
    const connection = this.createConnection(entry.server, {
      startupTimeoutMs: this.startupTimeoutMs,
      callTimeoutMs: this.callTimeoutMs,
      ...(this.onStderr ? { onStderr: this.onStderr } : {}),
    });

    entry.connection = connection;
    entry.discovering = this.discover(entry, connection, generation).finally(() => {
      entry.discovering = undefined;
    });
  }

  private async discover(
    entry: ManagedServer,
    connection: McpConnection,
    generation: number,
  ): Promise<void> {
    try {
      await connection.connect();
      const raw = await connection.listTools();

      // Invalidated while connecting: the manager already forgot this connection,
      // so neither its tools nor its failure belong to the current state.
      if (entry.generation !== generation) return;

      entry.tools = raw
        .map((tool) => this.buildTool(entry, tool))
        .filter((tool): tool is Tool => tool !== undefined);
    } catch (error) {
      if (entry.generation !== generation) return;

      entry.failure = errMessage(error);
      logger.warn(`MCP server "${entry.server.id}" is unavailable: ${entry.failure}`);
    } finally {
      // A connection opened for a state that the manager already dropped must not
      // stay behind with a live process.
      if (entry.generation !== generation) await connection.close();
    }
  }

  // Turns one remote tool into a harness tool. The approval gate lives in
  // `execute`, so nothing here decides more about safety than the kind.
  private buildTool(entry: ManagedServer, raw: RawMcpTool): Tool | undefined {
    const name = mcpToolName(entry.server.id, raw.name);
    if (!name) {
      logger.warn(
        `MCP server "${entry.server.id}" exposes a tool whose name "${raw.name}" has no usable characters; skipping it`,
      );

      return undefined;
    }

    const description =
      truncateDescription(raw.description, this.maxDescriptionChars) ||
      `Tool "${raw.name}" from MCP server "${entry.server.id}".`;
    const kind = approvalKind(entry.server.untrusted, raw.annotations);

    return {
      name,
      description,
      parameters: normalizeInputSchema(raw.inputSchema),
      execute: (ctx: ToolContext, args: unknown): Promise<ToolResult> =>
        this.executeRemoteTool(entry, name, raw.name, kind, ctx, args),
    };
  }

  // Asks for approval, then runs the remote call under the concurrency cap of its
  // server. Never throws: a denial and a broken transport both come back as an
  // error result.
  private async executeRemoteTool(
    entry: ManagedServer,
    name: string,
    remoteName: string,
    kind: "read" | "write" | "exec",
    ctx: ToolContext,
    args: unknown,
  ): Promise<ToolResult> {
    const decision = await ctx.approve({
      tool: name,
      kind,
      subject: `${name}: ${previewArgs(args)}`,
    });

    if (decision === "deny") {
      return { output: `Tool ${name} was denied`, isError: true };
    }

    const connection = entry.connection;
    if (!connection) {
      return {
        output: `MCP server "${entry.server.id}" is not connected`,
        isError: true,
      };
    }

    const options: CallToolOptions = {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(ctx.onOutput ? { onProgress: ctx.onOutput } : {}),
    };

    return entry.limiter.run(() => connection.callTool(remoteName, args, options));
  }

  private warnCollision(name: string): void {
    if (this.warnedCollisions.has(name)) return;

    this.warnedCollisions.add(name);
    logger.warn(
      `MCP tool "${name}" collides with a tool that is already registered; keeping the registered one`,
    );
  }
}
