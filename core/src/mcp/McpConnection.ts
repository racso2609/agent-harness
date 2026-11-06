import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type Progress } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResult } from "@/types/providers";
import { logger } from "@/utils/logger";
import type { ResolvedMcpServer } from "./McpConfig";
import { KILL_GRACE_MS, killProcessTree } from "./killTree";

// Lifecycle of one connection. `failed` and `closed` are terminal: the
// connection is never revived, a new instance is created instead (reload).
export type McpConnectionStatus = "idle" | "starting" | "ready" | "failed" | "closed";

export interface McpConnectionOptions {
  // Budget for spawning the server and completing the initialize handshake.
  startupTimeoutMs: number;
  // Budget for a single tools/call round trip.
  callTimeoutMs: number;
  // Sink for the server stderr, so a crash leaves a trace. Optional.
  onStderr?: (chunk: string) => void;
}

// One tool as the server describes it, before the harness reshapes it.
export interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface CallToolOptions {
  signal?: AbortSignal;
  // Text chunks streamed by the server through notifications/progress.
  onProgress?: (chunk: string) => void;
}

// Upper bound on tools/list pages, so a server that always returns a cursor
// cannot make the registry load forever.
const MAX_LIST_PAGES = 50;

const errMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Concatenates the text blocks of an MCP result. Images and embedded resources
// are skipped instead of failing the call: a text-only model cannot use them.
const collectText = (content: unknown): string => {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
  }

  return parts.join("\n");
};

// Extracts the text an MCP server may stream through notifications/progress,
// where new servers put partial output.
const progressText = (progress: Progress): string | undefined =>
  typeof progress.message === "string" ? progress.message : undefined;

// One stdio connection to one MCP server. Nothing is spawned until `connect`.
// The instance holds no module-level state, so several can coexist and a
// discarded one leaves nothing behind.
export class McpConnection {
  readonly server: ResolvedMcpServer;

  private readonly options: McpConnectionOptions;

  private state: McpConnectionStatus = "idle";

  private failure?: string;

  private client?: Client;

  private transport?: StdioClientTransport;

  private pid?: number;

  private closing?: Promise<void>;

  constructor(server: ResolvedMcpServer, options: McpConnectionOptions) {
    this.server = server;
    this.options = options;
  }

  get status(): McpConnectionStatus {
    return this.state;
  }

  get lastError(): string | undefined {
    return this.failure;
  }

  // Pid of the spawned server, available once `connect` has started it.
  get processId(): number | undefined {
    return this.pid;
  }

  // Spawns the server and completes the handshake. Rejects, with the state left
  // in `failed` and no process behind, when the server does not come up.
  async connect(): Promise<void> {
    if (this.state === "ready") return;
    if (this.state !== "idle") {
      throw new Error(`MCP connection for "${this.server.id}" cannot connect while ${this.state}`);
    }

    this.state = "starting";
    this.failure = undefined;

    const transport = new StdioClientTransport({
      command: this.server.command,
      args: this.server.args,
      env: this.server.env,
      ...(this.server.cwd ? { cwd: this.server.cwd } : {}),
      // Piped so a noisy server cannot write into the harness terminal.
      stderr: "pipe",
    });
    this.transport = transport;

    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      if (this.options.onStderr) this.options.onStderr(text);
      else logger.debug(`MCP server "${this.server.id}": ${text}`);
    });

    const client = new Client({ name: "racso-harness", version: "1.0.0" }, { capabilities: {} });
    this.client = client;

    // The transport drops its pid when the process dies, so it is captured
    // as soon as the process exists instead of read after the handshake.
    const recordPid = () => {
      this.pid ??= transport.pid ?? undefined;
    };
    const pidWatcher = setInterval(recordPid, 20);
    pidWatcher.unref();

    // A transport close (server exit, kill) freezes the connection instead of
    // letting later calls wait for answers that will never come.
    transport.onclose = () => this.markFailed(`MCP server "${this.server.id}" exited`);

    try {
      await this.withTimeout(
        client.connect(transport),
        this.options.startupTimeoutMs,
        `MCP server "${this.server.id}" did not finish the handshake within ${this.options.startupTimeoutMs}ms`,
      );

      recordPid();
      this.state = "ready";
    } catch (error) {
      this.markFailed(errMessage(error));
      await this.killProcess();
      throw new Error(this.lastError ?? errMessage(error), { cause: error });
    } finally {
      recordPid();
      clearInterval(pidWatcher);
    }
  }

  // Every tool the server exposes, following pagination to the end. A name
  // repeated across pages keeps its first definition.
  async listTools(): Promise<RawMcpTool[]> {
    const client = this.requireReady();
    const tools: RawMcpTool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await client.listTools(
        cursor ? { cursor } : undefined,
        // A slow but healthy server must not hit the SDK default; the call is
        // bounded by the same budget as tools/call.
        { timeout: this.options.callTimeoutMs },
      );

      for (const tool of result.tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);

        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
          ...(tool.annotations
            ? {
                annotations: {
                  ...(typeof tool.annotations.readOnlyHint === "boolean"
                    ? { readOnlyHint: tool.annotations.readOnlyHint }
                    : {}),
                  ...(typeof tool.annotations.destructiveHint === "boolean"
                    ? { destructiveHint: tool.annotations.destructiveHint }
                    : {}),
                },
              }
            : {}),
        });
      }

      cursor = result.nextCursor;
      if (!cursor) return tools;
    }

    logger.warn(
      `MCP server "${this.server.id}" still had tools after ${MAX_LIST_PAGES} pages; stopping there`,
    );
    return tools;
  }

  // Runs one remote tool. Transport failures and timeouts come back as an
  // error result: a broken server must not take the turn down.
  async callTool(name: string, args: unknown, opts: CallToolOptions = {}): Promise<ToolResult> {
    if (this.state !== "ready") {
      return { output: this.unavailableMessage(), isError: true };
    }

    const client = this.client;
    if (!client) return { output: this.unavailableMessage(), isError: true };

    const argumentsObject =
      args && typeof args === "object" ? (args as Record<string, unknown>) : undefined;

    try {
      const result = await client.callTool(
        { name, ...(argumentsObject ? { arguments: argumentsObject } : {}) },
        CallToolResultSchema,
        {
          timeout: this.options.callTimeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.onProgress
            ? {
                onprogress: (params) => {
                  const text = progressText(params);
                  if (text) opts.onProgress?.(text);
                },
              }
            : {}),
        },
      );

      const output = collectText(result.content);
      return { output, isError: result.isError === true };
    } catch (error) {
      if (opts.signal?.aborted) {
        return { output: `Tool "${name}" was cancelled`, isError: true };
      }

      return {
        output: `MCP tool "${name}" on server "${this.server.id}" failed: ${errMessage(error)}`,
        isError: true,
      };
    }
  }

  // Cuts the transport and the process tree. Idempotent: the same promise is
  // returned on every call.
  close(): Promise<void> {
    this.closing ??= this.doClose();
    return this.closing;
  }

  private async doClose(): Promise<void> {
    if (this.state === "closed") return;

 this.state = "closed";

 // The tree is walked and signalled first, while the server is still the
 // parent of everything it spawned, and even a failed connection gets the
 // full grace period. Closing the transport ends the server's stdin, and a
 // server that exits on that re-parents its children to init, where no
 // walk from its pid can reach them any more.
 await this.killProcess();

    // Closing the transport matters in both branches: a connection that
    // failed without the process dying (handshake timeout, a transport error
    // with no close behind it) still has calls in flight, and the SDK only
    // rejects them when the transport closes.
    try {
      await this.transport?.close();
    } catch (error) {
      logger.debug(`MCP server "${this.server.id}" transport close failed: ${errMessage(error)}`);
    }

    this.client = undefined;
  }

  private requireReady(): Client {
    if (this.state !== "ready" || !this.client) {
      throw new Error(this.unavailableMessage());
    }

    return this.client;
  }

  private unavailableMessage(): string {
    if (this.state === "failed" && this.failure) {
      return `MCP server "${this.server.id}" is unavailable: ${this.failure}`;
    }

    return `MCP server "${this.server.id}" is not connected (${this.state})`;
  }

  // Freezes the connection after a failure. Never resurrects a closed one.
  private markFailed(reason: string): void {
    if (this.state === "failed" || this.state === "closed") return;

    this.state = "failed";
    this.failure = reason;
  }

  // Terminates the server and everything it spawned: SIGTERM to each pid of
  // the tree, then SIGKILL for those still alive after a short grace period.
  // The tree is walked with `ps` because the SDK transport spawns the server
  // without `detached`, so the child does not lead its own process group and
  // killing `-pid` would reach the harness instead. Safe when the process is
 // already gone, and always given the full grace period: a tree walked
 // after the server exited no longer contains the children it left behind.
 private async killProcess(): Promise<void> {
 const pid = this.pid;
 if (pid === undefined) return;

 await killProcessTree(pid, undefined, KILL_GRACE_MS);
 }

  // Races a promise against a deadline. The losing promise's rejection is
  // swallowed so it cannot surface as an unhandled rejection.
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });

    promise.catch(() => {});

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
