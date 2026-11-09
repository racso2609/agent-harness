import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.fn();

vi.mock("../../src/utils/logger", () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

const { McpConnection } = await import("../../src/mcp/McpConnection");
import type { ToolContext } from "../../src/tools/Tool";
import { makeManager, makeTag, tagged, waitForDeath, type ServerSpec } from "./managerHarness";

// Tag of the servers this file spawns. Every afterEach sweeps what a test left
// behind and fails the file when something survived.
const TAG = makeTag("mcp-manager");

// Managers a test built, closed in afterEach so no suite leaves a server behind.
const opened: { close: () => Promise<void> }[] = [];

const manager = (
  servers: Record<string, ServerSpec>,
  options: Parameters<typeof makeManager>[2] = {},
) => {
  const built = makeManager(TAG, servers, {
    manager: { startupTimeoutMs: 5000, callTimeoutMs: 2000 },
    ...options,
  });
  opened.push(built.manager);

  return built;
};

// Records every approval request, and answers with the given decision.
const makeContext = (decision: "allow" | "deny" | "always" = "allow") => {
  const approvals: { tool: string; kind: string; subject: string }[] = [];
  const ctx: ToolContext = {
    cwd: process.cwd(),
    sessionId: "session",
    approve: async (request) => {
      approvals.push(request);
      return decision;
    },
  };

  return { ctx, approvals };
};

beforeEach(() => {
  warn.mockClear();
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((entry) => entry.close()));

  const leaked = tagged(TAG);
  expect(leaked, `processes tagged ${TAG} survived close()`).toEqual([]);
});

describe("McpManager lazy discovery", () => {
  it("starts no process until tools() is called", async () => {
    const { manager: mcp, createConnection } = manager({ fixture: {} });

    // Nothing is spawned by the constructor: no connection was even built.
    expect(createConnection).not.toHaveBeenCalled();
    expect(mcp.servers()).toEqual([
      { id: "fixture", transport: "stdio", status: "idle", toolCount: 0 },
    ]);

    mcp.tools();
    await mcp.ready();

    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(mcp.servers()).toEqual([
      { id: "fixture", transport: "stdio", status: "ready", toolCount: 3 },
    ]);
  });

  it("opens no connection once the manager is closed", async () => {
    // A manager that never discovered anything: this one pins the lazy case, not
    // the invariant that keeps a closed manager closed. That one needs a manager
    // that had already connected, and is pinned by the case below.
    const { manager: mcp, connections, createConnection } = manager({ fixture: {} });

    expect(createConnection).not.toHaveBeenCalled();

    await mcp.close();

    expect(mcp.tools()).toEqual([]);
    await mcp.ready();
    expect(mcp.toolForName("mcp__fixture__echo")).toBeUndefined();

    // Nothing was built and nothing was spawned after close().
    expect(createConnection).not.toHaveBeenCalled();
    expect(connections).toHaveLength(0);
    expect(mcp.servers()).toEqual([]);
  });

  // The invariant of `close()`: `doClose` empties `state`, and that is the only
  // thing keeping a closed manager closed. A manager that already connected is
  // what makes the mutation visible: without the emptying, `state` still holds
  // the entry, so the next `tools()` starts a second connection and `servers()`
  // reports the first one as `closed`.
  //
  // One connection was built before close(), and nothing is connected after it.
  // The count of `createConnection` does not discriminate on its own: a
  // connection rebuilt from an entry that was never emptied never reaches
  // `connect()`, because `doClose` left it closed, so the count is 1 either way.
  // What discriminates is the tool lookup below; the count only catches a close
  // that forgot to kill the server it dropped.
  it("builds no connection after close(), on a manager that had already connected", async () => {
    const { manager: mcp, connections, createConnection } = manager({ fixture: {} });

    // The handshake is over once `ready()` resolves: the connection has a status.
    await mcp.ready();
    expect(connections[0]?.status).toBe("ready");

    await mcp.close();

    // Every entry point that would wake a server.
    mcp.tools();
    await mcp.ready();
    expect(mcp.toolForName("mcp__fixture__echo")).toBeUndefined();

    // Not the discriminator: without the emptying in `doClose`, `state` still
    // holds the entry `tools()` walks and a connection is rebuilt, but it never
    // connects, so this stays 1. The lookup above is the one that turns red.
    expect(createConnection).toHaveBeenCalledTimes(1);
    expect(connections).toHaveLength(1);
  });

  // The listing of the same manager. Without the emptying, `doClose` only kills
  // the connection and `servers()` keeps reporting the entry, as `closed` with
  // the tools it had discovered.
  it("lists no server after close(), on a manager that had already connected", async () => {
    const { manager: mcp } = manager({ fixture: {} });

    await mcp.ready();
    expect(mcp.servers()).toEqual([
      { id: "fixture", transport: "stdio", status: "ready", toolCount: 3 },
    ]);

    await mcp.close();

    expect(mcp.servers()).toEqual([]);
    expect(mcp.isClosed()).toBe(true);
  });

  it("connects once and lists once across two tools() calls", async () => {
    const listSpy = vi.spyOn(McpConnection.prototype, "listTools");
    const { manager: mcp, connections } = manager({ fixture: {} });

    mcp.tools();
    await mcp.ready();

    const first = mcp.tools().map((tool) => tool.name);
    const second = mcp.tools().map((tool) => tool.name);

    expect(first).toEqual(second);
    expect(connections).toHaveLength(1);
    expect(listSpy).toHaveBeenCalledTimes(1);
    listSpy.mockRestore();
  });

  it("resolves a single tool by name, connecting on demand", async () => {
    const { manager: mcp, createConnection } = manager({ fixture: {} });

    expect(createConnection).not.toHaveBeenCalled();
    expect(mcp.toolForName("mcp__fixture__echo")).toBeUndefined();

    await mcp.ready();

    expect(mcp.toolForName("mcp__fixture__echo")?.name).toBe("mcp__fixture__echo");
    expect(mcp.toolForName("mcp__fixture__missing")).toBeUndefined();
  });

  it("reconnects with a new connection after invalidate()", async () => {
    const { manager: mcp, connections } = manager({ fixture: {} });

    await mcp.ready();
    expect(connections).toHaveLength(1);
    expect(mcp.servers()[0]?.status).toBe("ready");

    await mcp.invalidate("fixture");

    // The connection is forgotten, not kept around in a terminal state: the next
    // discovery starts from scratch.
    expect(mcp.servers()[0]).toEqual({
      id: "fixture",
      transport: "stdio",
      status: "idle",
      toolCount: 0,
    });
    expect(connections[0]?.status).toBe("closed");

    // `tools()` only kicks the discovery off, so the state is observable while the
    // handshake is in flight.
    mcp.tools();
    expect(mcp.servers()[0]?.status).toBe("starting");
    await mcp.ready();

    expect(connections).toHaveLength(2);
    expect(connections[1]).not.toBe(connections[0]);
    expect(connections[1]?.status).toBe("ready");
    expect(mcp.servers()[0]?.status).toBe("ready");
    expect(mcp.servers()[0]?.toolCount).toBe(3);
  });

  it("starts a process on every invalidate cycle, with nothing left behind", async () => {
    const { manager: mcp, connections } = manager({ fixture: {} });

    await mcp.ready();
    const firstPid = connections[0]?.processId;
    expect(firstPid).toBeGreaterThan(0);

    await mcp.invalidate("fixture");
    expect(await waitForDeath(firstPid as number)).toBe(true);

    await mcp.ready();
    expect(connections[1]?.processId).toBeGreaterThan(0);
  });

  it("is idempotent on close() and leaves no process alive", async () => {
    const { manager: mcp, connections } = manager({ fixture: {} });

    await mcp.ready();
    const pid = connections[0]?.processId;
    expect(pid).toBeGreaterThan(0);

    await Promise.all([mcp.close(), mcp.close(), mcp.close()]);

    expect(connections[0]?.status).toBe("closed");
    expect(await waitForDeath(pid as number)).toBe(true);
    // A closed manager never spawns again.
    expect(mcp.tools()).toEqual([]);
    await mcp.ready();
    expect(connections).toHaveLength(1);
    expect(mcp.servers()).toEqual([]);
  });
});

describe("McpManager naming", () => {
  it("exposes the remote tools under mcp__<server>__<tool>", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    expect(mcp.tools().map((tool) => tool.name)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__fail",
      "mcp__fixture__slow",
    ]);
  });

  it("truncates descriptions to maxDescriptionChars", async () => {
    const { manager: mcp } = manager({ fixture: {} }, { config: { maxDescriptionChars: 10 } });
    await mcp.ready();

    const echo = mcp.toolForName("mcp__fixture__echo");
    expect(echo?.description).toBe("Echoes ba…");
  });

  it("normalizes the input schema of the remote tool", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const echo = mcp.toolForName("mcp__fixture__echo");
    expect(echo?.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string", description: "Text to echo" } },
      required: ["text"],
    });

    const fail = mcp.toolForName("mcp__fixture__fail");
    expect(fail?.parameters).toEqual({ type: "object", properties: {} });
  });

  it("skips a remote tool whose name clashes with one already taken", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const tools = mcp.tools(new Set(["mcp__fixture__echo"]));

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__fixture__fail", "mcp__fixture__slow"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('MCP tool "mcp__fixture__echo" collides'),
    );
  });

  it("warns once about a collision, not on every tools() call", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const occupied = new Set(["mcp__fixture__echo"]);
    mcp.tools(occupied);
    mcp.tools(occupied);
    mcp.tools(occupied);

    const warnings = warn.mock.calls.filter(([line]: [string]) => line.includes("collides"));
    expect(warnings).toHaveLength(1);
  });
});

describe("McpManager approvals", () => {
  const expectKind = async (
    servers: Record<string, ServerSpec>,
    kind: string,
    tool: string,
    isError = false,
  ) => {
    const { manager: mcp } = manager(servers);
    await mcp.ready();

    const target = mcp.toolForName(tool);
    expect(target, `tool ${tool} was not discovered`).toBeDefined();

    const { ctx, approvals } = makeContext();
    const result = await target?.execute(ctx, { text: "hello" });

    expect(result?.isError).toBe(isError);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.tool).toBe(tool);
    expect(approvals[0]?.kind).toBe(kind);
    expect(approvals[0]?.subject).toBe(`${tool}: {"text":"hello"}`);
  };

  it("asks for read when the tool declares readOnlyHint", async () => {
    await expectKind({ fixture: {} }, "read", "mcp__fixture__echo");
  });

  it("asks for exec when the tool declares destructiveHint", async () => {
    await expectKind({ fixture: {} }, "exec", "mcp__fixture__slow");
  });

  it("asks for write when the tool declares no annotation", async () => {
    // The fixture's "fail" tool always answers with an error, which is what makes
    // it the one tool with no annotations at all.
    await expectKind({ fixture: {} }, "write", "mcp__fixture__fail", true);
  });

  it("never goes below exec for an untrusted server", async () => {
    await expectKind({ fixture: { untrusted: true } }, "exec", "mcp__fixture__echo");
  });

  it("does not reach the server when the call is denied", async () => {
    const { manager: mcp, connections } = manager({ fixture: {} });
    await mcp.ready();

    const callSpy = vi.spyOn(connections[0], "callTool");
    const { ctx } = makeContext("deny");

    const result = await mcp.toolForName("mcp__fixture__echo")?.execute(ctx, { text: "hi" });

    expect(result).toEqual({ output: "Tool mcp__fixture__echo was denied", isError: true });
    expect(callSpy).not.toHaveBeenCalled();
  });

  it("redacts the credentials of the arguments in the approval prompt", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx, approvals } = makeContext();
    const token = "sk-live-0123456789";
    const result = await mcp
      .toolForName("mcp__fixture__echo")
      ?.execute(ctx, { token, password: "hunter2", text: "hello" });

    // Redacting only the preview keeps the call itself intact.
    expect(result).toEqual({ output: "hello", isError: false });

    const subject = approvals[0]?.subject ?? "";
    expect(subject).toBe('mcp__fixture__echo: {"token":"***","password":"***","text":"hello"}');
    expect(subject).not.toContain(token);
    expect(subject).not.toContain("hunter2");
    // An innocent key is not redacted.
    expect(subject).toContain('"text":"hello"');
  });

  it("redacts a credential nested one level down", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx, approvals } = makeContext();
    const apiKey = "AKIA-secret-value";
    await mcp.toolForName("mcp__fixture__echo")?.execute(ctx, {
      params: { apiKey, query: "select 1" },
    });

    const subject = approvals[0]?.subject ?? "";
    expect(subject).toContain('"apiKey":"***"');
    expect(subject).not.toContain(apiKey);
    expect(subject).toContain('"query":"select 1"');
  });

  it("redacts a credential inside an array of objects", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx, approvals } = makeContext();
    await mcp.toolForName("mcp__fixture__echo")?.execute(ctx, {
      headers: [{ Authorization: "Bearer abcdef" }, { name: "x-tenant" }],
    });

    const subject = approvals[0]?.subject ?? "";
    expect(subject).toContain('"Authorization":"***"');
    expect(subject).not.toContain("abcdef");
    expect(subject).toContain('"name":"x-tenant"');
  });

  it("keeps the preview short even when the secrets sit before the cut", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx, approvals } = makeContext();
    const token = "sk-live-a-very-long-token-value";
    await mcp.toolForName("mcp__fixture__echo")?.execute(ctx, { token, text: "x".repeat(400) });

    const subject = approvals[0]?.subject ?? "";
    expect(subject).not.toContain(token);
    expect(subject).toContain("…");
  });

  it("runs the call when the decision is always", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx } = makeContext("always");
    const result = await mcp.toolForName("mcp__fixture__echo")?.execute(ctx, { text: "hi" });

    expect(result).toEqual({ output: "hi", isError: false });
  });

  it("returns the error result of a failing remote tool instead of throwing", async () => {
    const { manager: mcp } = manager({ fixture: {} });
    await mcp.ready();

    const { ctx } = makeContext();
    const result = await mcp.toolForName("mcp__fixture__fail")?.execute(ctx, {});

    expect(result).toEqual({ output: "tool failed on purpose", isError: true });
  });
});

describe("McpManager concurrency", () => {
  // The fixture answers "slow" after CALL_DELAY_MS, so two concurrent calls take
  // one delay when they overlap and two when they are serialized.
  const DELAY_MS = 300;

  const slowCalls = async (maxConcurrentCalls: number) => {
    const { manager: mcp } = manager(
      { fixture: { args: ["--slow-call"], env: { CALL_DELAY_MS: String(DELAY_MS) } } },
      { config: { maxConcurrentCalls, callTimeoutMs: 5000 } },
    );
    await mcp.ready();

    const tool = mcp.toolForName("mcp__fixture__slow");
    const { ctx } = makeContext();

    const started = Date.now();
    const results = await Promise.all([
      tool?.execute(ctx, { text: "one" }),
      tool?.execute(ctx, { text: "two" }),
    ]);

    return { elapsed: Date.now() - started, results };
  };

  it("serializes the calls of one server under maxConcurrentCalls", async () => {
    const { elapsed, results } = await slowCalls(1);

    expect(results).toEqual([
      { output: "slow ok", isError: false },
      { output: "slow ok", isError: false },
    ]);
    // Two delays worth of work, with a margin so a slow machine cannot turn this
    // into a flaky assertion: the floor only proves they did not overlap.
    expect(elapsed).toBeGreaterThanOrEqual(DELAY_MS * 1.5);
  });

  it("lets the calls overlap when the cap allows it", async () => {
    const { elapsed, results } = await slowCalls(2);

    expect(results).toEqual([
      { output: "slow ok", isError: false },
      { output: "slow ok", isError: false },
    ]);
    expect(elapsed).toBeLessThan(DELAY_MS * 1.5);
  });
});

describe("McpManager failure isolation", () => {
  it("marks a server that cannot start as failed and keeps the others usable", async () => {
    const { manager: mcp } = manager({
      dead: { args: ["--exit-on-start"] },
      fixture: {},
    });

    await mcp.ready();

    const summaries = mcp.servers();
    const dead = summaries.find((entry) => entry.id === "dead");
    const healthy = summaries.find((entry) => entry.id === "fixture");

    expect(dead?.status).toBe("failed");
    expect(dead?.error).toBeTruthy();
    expect(healthy?.status).toBe("ready");
    expect(healthy?.toolCount).toBe(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MCP server "dead" is unavailable'));

    const { ctx } = makeContext();
    const result = await mcp
      .toolForName("mcp__fixture__echo")
      ?.execute(ctx, { text: "still here" });

    expect(result).toEqual({ output: "still here", isError: false });
    expect(mcp.tools().map((tool) => tool.name)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__fail",
      "mcp__fixture__slow",
    ]);
  });
});
