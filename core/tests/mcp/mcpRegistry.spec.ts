import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The registry logs a provider that throws or repeats a name; the tests below
// assert on those calls instead of letting them reach stderr. `captured` keeps
// the object handed to the registry: after `vi.resetModules()` the graph under
// test holds its own instance, so a static import would not reach it.
const captured = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../src/utils/logger", () => ({
  logger: {
    fatal: vi.fn(),
    error: vi.fn(),
    warn: captured.warn,
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

import type { Config } from "../../src/configuration";
import type { ResolvedMcpServer } from "../../src/mcp/McpConfig";
import { McpConnection } from "../../src/mcp/McpConnection";
import { McpManager } from "../../src/mcp/McpManager";
import type { Tool, ToolContext } from "../../src/tools/Tool";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
// Every case here builds its registry through this wrapper, so all of them go
// through the same dynamic import: the kill-switch test re-imports the module
// graph with `vi.resetModules()` and the others must keep seeing the same code.
// Signature copied from the module so the call sites stay type-checked.
type BuildToolRegistry = typeof import("../../src/tools").createToolRegistry;

const createToolRegistry: BuildToolRegistry = async (...args) => {
  const { createToolRegistry: build } = await import("../../src/tools");
  return build(...args);
};

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

// Through the hoisted reference: after a `vi.resetModules()` the registry under
// test uses the instance `vi.mock` builds, not a value captured at import time.
const warn = () => captured.warn;

beforeEach(() => {
  warn().mockClear();
});

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

  it("warns once per name a provider repeats, and keeps the first one", () => {
    const registry = new ToolRegistry([makeTool("readFile")]);
    registry.addProvider(() => [
      { ...makeTool("dup"), description: "first" },
      { ...makeTool("dup"), description: "second" },
    ]);

    // A single lookup: the duplicate is dropped from that same snapshot.
    const specs = registry.specs();
    expect(specs.map((spec) => spec.name)).toEqual(["readFile", "dup"]);
    expect(registry.list()[1]?.description).toBe("first");

    // One warning for the name, emitted by the first lookup only.
    const duplicates = warn().mock.calls.filter(([line]: [string]) =>
      String(line).includes('duplicate tool "dup"'),
    );
    expect(duplicates).toHaveLength(1);
  });

  it("does not warn when a registered tool wins over a provider", () => {
    const registry = new ToolRegistry([makeTool("shared")]);
    registry.addProvider(() => [makeTool("shared")]);

    expect(registry.list().map((tool) => tool.name)).toEqual(["shared"]);
    expect(warn()).not.toHaveBeenCalled();
  });

  it("keeps the static tools when a provider throws", async () => {
    const registry = new ToolRegistry([makeTool("native")]);
    registry.addProvider(() => {
      throw new Error("provider exploded");
    });

    // No exception escapes: the turn survives a broken source of tools.
    expect(registry.specs().map((spec) => spec.name)).toEqual(["native"]);
    expect(registry.list().map((tool) => tool.name)).toEqual(["native"]);
    expect(registry.get("native")?.name).toBe("native");
    expect(await registry.execute(ctx, { id: "call_1", name: "native", args: {} })).toEqual({
      output: "native ran",
    });
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining("provider exploded"));
  });

  it("logs a throwing provider once, not on every lookup", () => {
    const registry = new ToolRegistry([makeTool("native")]);
    const provider = vi.fn(() => {
      throw new Error("provider exploded");
    });
    registry.addProvider(provider);

    // A name that is not registered is what makes the registry ask the provider.
    registry.get("missing");
    registry.get("missing");

    // The provider is asked on every lookup; the warning is not repeated.
    expect(provider).toHaveBeenCalledTimes(2);
    const reports = warn().mock.calls.filter(([line]: [string]) =>
      String(line).includes("provider exploded"),
    );
    expect(reports).toHaveLength(1);
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
  it("keeps a native tool the remote one would take the name of", async () => {
    const { manager } = makeManager();

    // The fixture exposes `echo`, which as a composite name is
    // mcp__fixture__echo: a real native tool by that name must survive the
    // wiring, not just a hand-built registry.
    const native: Tool = {
      name: "mcp__fixture__echo",
      description: "native tool with a remote-looking name",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: "native ran" }),
    };
    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, {
      mcp: manager,
    });
    registry.register(native);

    await registry.list();
    await manager.ready();

    expect(registry.get("mcp__fixture__echo")).toBe(native);
    expect(
      await registry.execute(ctx, { id: "call_1", name: "mcp__fixture__echo", args: {} }),
    ).toEqual({ output: "native ran" });
    // The other remote tools of that server are still offered.
    expect(registry.list().map((tool) => tool.name)).toContain("mcp__fixture__fail");
  });

  it("registers the MCP tools when MCP is enabled and there is no allowlist", async () => {
    const { manager } = makeManager();
    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, {
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
    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: false } }), undefined, {
      mcp: manager,
    });
    await manager.ready();

    expect(registry.list().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
  });

  it("registers no MCP tool when there is no manager", async () => {
    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: true } }));

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
    const registry = await createToolRegistry(
      makeConfig({ mcp: { enabled: true } }),
      ["readFile"],
      {
        mcp: manager,
      },
    );

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
    expect(
      registry.list().some((tool) => tool.name.startsWith("mcp__")),
      "the provider is registered, so the allowlist is what keeps every mcp__ name out",
    ).toBe(false);

    // The lookups above asked the manager, whose provider starts the discovery:
    // what an allowlist keeps out is the tools, not the connection.
    await manager.ready();
    expect(connections).toHaveLength(1);
    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
  });

  it("never asks the manager for an agent whose allowlist names no MCP tool", async () => {
    const { manager, connections } = makeManager();
    const toolsSpy = vi.spyOn(manager, "tools");
    const readySpy = vi.spyOn(manager, "ready");

    const registry = await createToolRegistry(
      makeConfig({ mcp: { enabled: true } }),
      ["readFile"],
      {
        mcp: manager,
      },
    );

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
    // Discovery spawns servers, and an agent that names no remote tool has nothing
    // to gain from it: the provider is not installed at all.
    expect(toolsSpy).not.toHaveBeenCalled();
    expect(readySpy).not.toHaveBeenCalled();
    expect(connections).toEqual([]);
  });

  it("resolves an MCP tool an allowlist names, and only that one", async () => {
    // What tells the gate of the allowlist apart from no gate at all: with MCP
    // enabled the provider is registered even for an agent that has an allowlist,
    // so a named mcp__ tool resolves. A gate that skips the provider leaves
    // registry.get() with nothing to ask.
    const { manager, connections } = makeManager();
    const registry = await createToolRegistry(
      makeConfig({ mcp: { enabled: true } }),
      ["readFile", "mcp__fixture__echo"],
      {
        mcp: manager,
      },
    );

    await manager.ready();

    // Only the named remote tool, never the whole server.
    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile", "mcp__fixture__echo"]);
    expect(registry.get("mcp__fixture__echo")).toBeDefined();
    expect(registry.get("mcp__fixture__fail")).toBeUndefined();
    expect(connections).toHaveLength(1);

    // The twin: an allowlist without the mcp__ name gets no remote tool, and it
    // does not even ask the manager, because discovery would spawn a server it
    // cannot use.
    const toolsSpy = vi.spyOn(manager, "tools");
    const other = await createToolRegistry(makeConfig({ mcp: { enabled: true } }), ["readFile"], {
      mcp: manager,
    });

    expect(other.list().map((tool) => tool.name)).toEqual(["readFile"]);
    expect(toolsSpy).not.toHaveBeenCalled();
    expect(
      other.get("mcp__fixture__echo"),
      "the name is not in its allowlist, so the registry does not offer it",
    ).toBeUndefined();
  });

  it("reads an allowlist entry as the composite the manager offers", async () => {
    // An allowlist is written by hand and compared against the composite the
    // manager builds, so the entry is read with the same parser that reads those
    // names. `mcp__fixture__echo` is the shape the agent has to write.
    const { manager } = makeManager();
    const registry = await createToolRegistry(
      makeConfig({ mcp: { enabled: true } }),
      ["readFile", "mcp__fixture__echo"],
      {
        mcp: manager,
      },
    );

    await manager.ready();

    expect(registry.get("mcp__fixture__echo")).toBeDefined();
    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile", "mcp__fixture__echo"]);
  });

  it("does not ask the manager for an allowlist entry that is not a composite", async () => {
    // `mcp__fixture` is not mcp__<server>__<tool>, so nothing could ever resolve it
    // and discovery would spawn a server for nothing.
    const { manager, connections } = makeManager();
    const toolsSpy = vi.spyOn(manager, "tools");

    const registry = await createToolRegistry(
      makeConfig({ mcp: { enabled: true } }),
      ["readFile", "mcp__fixture"],
      {
        mcp: manager,
      },
    );

    expect(registry.list().map((tool) => tool.name)).toEqual(["readFile"]);
    expect(toolsSpy).not.toHaveBeenCalled();
    expect(connections).toEqual([]);
  });

  it("lets a tool registered after the wiring keep the name a remote tool wants", async () => {
    // The call the wiring makes into the manager, from a registry wired the way a
    // session wires it.
    const { manager } = makeManager();
    const toolsSpy = vi.spyOn(manager, "tools");

    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, {
      mcp: manager,
    });
    // A tool registered on the registry itself, off the wiring's books: no native
    // tool is named mcp__fixture__echo, so the clash is built here and the wiring
    // cannot know about it. `dynamic()` on every lookup is what has to keep it.
    registry.register(makeTool("mcp__fixture__echo"));

    await manager.ready();
    registry.list();

    // What the wiring hands over holds the names it knows about, so the manager
    // can keep its own remote tool out of the way.
    expect(toolsSpy).toHaveBeenCalled();
    const occupied = toolsSpy.mock.calls[0]?.[0];
    expect(occupied?.has("readFile")).toBe(true);

    // The registry drops the clash on every lookup, which is the only layer that
    // can see a tool registered after the wiring ran; the manager offered it.
    const tool = registry.get("mcp__fixture__echo");
    expect(tool?.description).toBe("mcp__fixture__echo tool");
    const offered = (toolsSpy.mock.results.at(-1)?.value as Tool[]).map((entry) => entry.name);
    expect(offered).toContain("mcp__fixture__echo");
    expect(offered).toContain("mcp__fixture__fail");
  });

  it("asks the same manager for its tools when there is no allowlist", async () => {
    // The negative twin of the option-A case above, so the spy can tell the two
    // paths apart instead of passing because nothing asks the manager ever.
    const { manager } = makeManager();
    const toolsSpy = vi.spyOn(manager, "tools");

    const registry = await createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, {
      mcp: manager,
    });
    registry.list();

    expect(toolsSpy).toHaveBeenCalledTimes(1);
  });

  it("offers no MCP tool when the environment disables MCP", async () => {
    vi.stubEnv("RACSO_HARNESS_MCP_DISABLED", "1");
    // env.ts snapshots process.env at import time, so the whole graph has to be
    // re-imported for the stub to be seen.
    vi.resetModules();

    try {
      const { createToolRegistry: build } = await import("../../src/tools");
      const { manager } = makeManager();
      const toolsSpy = vi.spyOn(manager, "tools");

      const registry = build(makeConfig({ mcp: { enabled: true } }), undefined, { mcp: manager });
      await manager.ready();

      expect(registry.list().some((tool) => tool.name.startsWith("mcp__"))).toBe(false);
      expect(toolsSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("leaves no server running after the manager is closed", async () => {
    const { manager, connections } = makeManager();
    await createToolRegistry(makeConfig({ mcp: { enabled: true } }), undefined, { mcp: manager });

    await manager.ready();
    const pid = connections[0]?.processId;
    expect(pid).toBeGreaterThan(0);

    await manager.close();

    expect(await waitForDeath(pid as number)).toBe(true);
  });
});
