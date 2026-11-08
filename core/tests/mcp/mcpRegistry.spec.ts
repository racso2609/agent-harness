import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/configuration";
import type { ResolvedMcpServer } from "../../src/mcp/McpConfig";
import { McpConnection } from "../../src/mcp/McpConnection";
import { McpManager } from "../../src/mcp/McpManager";
import type { Tool, ToolContext } from "../../src/tools/Tool";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import { createToolRegistry } from "../../src/tools";
import { makeMcpConfig, makeTag, tagged, waitForDeath } from "./managerHarness";

const TAG = makeTag("mcp-registry");

const ctx: ToolContext = {
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => "allow",
};

const makeTool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ output: `${name} ran` }),
});

// A manager over the fixture that a test can also close.
const opened: {
  close: () => Promise<void>;
}[] = [];

const makeManager = (servers: Record<string, { args?: string[] }> = { fixture: {} }) => {
  const connections: McpConnection[] = [];
  const manager = new McpManager(
    { mcp: makeMcpConfig(TAG, servers) },
    {
      startupTimeoutMs: 5000,
      callTimeoutMs: 2000,
      createConnection: (server: ResolvedMcpServer, options) => {
        const connection = new McpConnection(server, options);
        connections.push(connection);
        return connection;
      },
    },
  );
  opened.push(manager);

  return { manager, connections };
};

// A Config stand-in: createToolRegistry only reads `.config`.
const makeConfig = (config: Record<string, unknown> = {}) =>
  ({ config: { providers: {}, tools: {}, ...config } }) as unknown as Config;

afterEach(async () => {
  await Promise.all(opened.splice(0).map((entry) => entry.close()));

  const leaked = tagged(TAG);
  expect(leaked, `processes tagged ${TAG} survived`).toEqual([]);
});

describe("ToolRegistry providers", () => {
  it("keeps the behaviour of a registry without providers", () => {
    const registry = new ToolRegistry([makeTool("readFile")]);

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
    expect(registry.get("readFile")?.name).toBe("readFile");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.specs().map((spec) => spec.name)).toEqual(["readFile"]);
  });

  it("merges the provider tools into list(), get() and specs()", () => {
    const registry = new ToolRegistry([makeTool("readFile")]);
    registry.addProvider(() => [makeTool("mcp__x__echo")]);

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile", "mcp__x__echo"]);
    expect(registry.get("mcp__x__echo")?.name).toBe("mcp__x__echo");
    expect(registry.specs().map((spec) => spec.name)).toEqual(["readFile", "mcp__x__echo"]);
  });

  it("lets a static tool win a name clash with a provider tool", async () => {
    const registry = new ToolRegistry([makeTool("shared")]);
    registry.addProvider(() => [makeTool("shared")]);

    expect(registry.list().map((tool) => tool.name)).toEqual(["shared"]);
    expect(await registry.execute(ctx, { id: "call_1", name: "shared", args: {} })).toEqual({
      output: "shared ran",
    });
  });

  it("lets the first provider win a clash with a second one", () => {
    const registry = new ToolRegistry();
    registry.addProvider(() => [{ ...makeTool("dup"), description: "first" }]);
    registry.addProvider(() => [{ ...makeTool("dup"), description: "second" }]);

    expect(registry.list().map((tool) => tool.description)).toEqual(["first"]);
  });

  it("resolves a tool a provider only starts returning later", async () => {
    let available: Tool[] = [];
    const registry = new ToolRegistry([makeTool("readFile")]);
    registry.addProvider(() => available);

    // Not there yet: exactly what a registry built before MCP finished connecting
    // sees.
    expect(registry.get("mcp__x__echo")).toBeUndefined();

    available = [makeTool("mcp__x__echo")];

    expect(registry.get("mcp__x__echo")?.name).toBe("mcp__x__echo");
    expect(await registry.execute(ctx, { id: "call_1", name: "mcp__x__echo", args: {} })).toEqual({
      output: "mcp__x__echo ran",
    });
  });

  it("exposes the MCP tools of a real manager next to the native ones", async () => {
    const { manager } = makeManager();
    const registry = new ToolRegistry([makeTool("readFile")]);
    registry.addProvider(() => manager.tools(new Set(["readFile"])));

    expect(registry.specs().map((spec) => spec.name)).toEqual(["readFile"]);

    await manager.ready();

    expect(registry.specs().map((spec) => spec.name)).toEqual([
      "readFile",
      "mcp__fixture__echo",
      "mcp__fixture__fail",
      "mcp__fixture__slow",
    ]);

    // Resolved by name only once the discovery landed, from a registry that was
    // built before anything existed.
    const result = await registry.execute(ctx, {
      id: "call_1",
      name: "mcp__fixture__echo",
      args: { text: "through the registry" },
    });

    expect(result).toEqual({ output: "through the registry", isError: false });
  });

  it("keeps the native tool when a remote tool wants its name", async () => {
    const { manager } = makeManager();
    const registry = new ToolRegistry([makeTool("mcp__fixture__echo")]);
    registry.addProvider(() => manager.tools(new Set(["mcp__fixture__echo"])));

    await manager.ready();

    // The native tool keeps the name; the remote one is skipped and the other
    // remote tools of that server are still offered.
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__fail",
      "mcp__fixture__slow",
    ]);
    expect(
      await registry.execute(ctx, { id: "call_1", name: "mcp__fixture__echo", args: {} }),
    ).toEqual({ output: "mcp__fixture__echo ran" });
  });

  it("reports an unknown MCP name like any other unknown tool", async () => {
    const { manager } = makeManager();
    const registry = new ToolRegistry();
    registry.addProvider(() => manager.tools());
    await manager.ready();

    await expect(
      registry.execute(ctx, { id: "call_1", name: "mcp__fixture__missing", args: {} }),
    ).resolves.toEqual({ output: "Unknown tool: mcp__fixture__missing", isError: true });
  });
});

describe("createToolRegistry and MCP", () => {
  it("registers the MCP tools when MCP is enabled and there is no allowlist", async () => {
    const { manager } = makeManager();
    const registry = createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, {
      mcp: manager,
    });

    expect(registry.list().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);

    await manager.ready();

    const names = registry.list().map((tool) => tool.name);
    expect(names).toContain("shell");
    expect(names).toContain("mcp__fixture__echo");
    expect(registry.get("mcp__fixture__echo")).toBeDefined();
  });

  it("registers no MCP tool when mcp.enabled is false", async () => {
    const { manager } = makeManager();
    const registry = createToolRegistry(makeConfig({ mcp: { enabled: false } }), undefined, {
      mcp: manager,
    });
    await manager.ready();

    expect(registry.list().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
  });

  it("registers no MCP tool when there is no manager", () => {
    const registry = createToolRegistry(makeConfig({ mcp: { enabled: true } }));

    expect(registry.list().map((tool) => tool.name)).toEqual([
      "shell",
      "readFile",
      "writeFile",
      "listDir",
      "spawn",
    ]);
  });

  it("gives an agent with an allowlist exactly its list, with no MCP behind it", async () => {
    const { manager, connections } = makeManager();
    const registry = createToolRegistry(makeConfig({ mcp: { enabled: true } }), ["readFile"], {
      mcp: manager,
    });

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);

    // Nothing was even asked of the manager: the connections are opened lazily by
    // the provider, and an allowlist never installs one.
    manager.tools();
    await manager.ready();
    expect(connections).toHaveLength(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
  });

  it("leaves no server running after the manager is closed", async () => {
    const { manager, connections } = makeManager();
    createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, { mcp: manager });

    await manager.ready();
    const pid = connections[0]?.processId;
    expect(pid).toBeGreaterThan(0);

    await manager.close();

    expect(await waitForDeath(pid as number)).toBe(true);
  });
});
