import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import { createHarness } from "../../src/harness";
import type { McpConfig } from "../../src/mcp/McpConfig";
import { SessionManager } from "../../src/session/SessionManager";
import type { SessionStore } from "../../src/session/SessionStore";
import { makeMcpConfig, makeTag, tagged, waitForDeath } from "./managerHarness";

// Tag of the servers this file spawns. Every afterEach sweeps what a test left
// behind and fails the file when something survived.
const TAG = makeTag("mcp-session");

// A Config stand-in carrying only what the session reads. A real Config would
// read and write the user's config.json.
const makeConfig = (mcp: McpConfig) =>
  ({
    config: { mcp, skills: { enabled: false }, tools: {} },
    listProviders: () => [],
    listProviderDetails: () => [],
    configureProvider: vi.fn(),
    removeProvider: vi.fn(),
    writeConfig: vi.fn(),
  }) as unknown as Config;

const makeStore = () =>
  ({
    save: vi.fn(),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
  }) as unknown as SessionStore;

const makeSession = (servers: Record<string, { args?: string[] }> = { fixture: {} }) => {
  const config = makeConfig(makeMcpConfig(TAG, servers));

  return new SessionManager(config, makeStore());
};

// Waits for every connection of the session manager to settle, so an assertion
// on `servers()` never races the handshake.
const ready = (session: SessionManager) => session.mcp.ready();

const pids = () => tagged(TAG).map((entry) => entry.pid);

afterEach(() => {
  const leaked = tagged(TAG);
  expect(leaked, `processes tagged ${TAG} survived the test`).toEqual([]);
});

describe("SessionManager MCP wiring", () => {
  it("builds a manager but starts no server until a tool is looked up", () => {
    const session = makeSession();

    // The manager exists (the registries need it) and it is lazy: building the
    // session spawns nothing.
    expect(session.listMcpServers()).toEqual([
      { id: "fixture", transport: "stdio", status: "idle", toolCount: 0 },
    ]);
    expect(pids()).toEqual([]);
  });

  it("shares one manager across the registries it rebuilds", async () => {
    const session = makeSession();
    const manager = session.mcp;

    // The registry built by the constructor discovers through that manager.
    session.tools.list();
    await ready(session);

    expect(session.listMcpServers()[0]?.status).toBe("ready");
    // A later registry (the one setAgent would build) does not get a manager of
    // its own: the same instance is in charge, and no second server was spawned.
    expect(session.mcp).toBe(manager);
    expect(pids()).toHaveLength(1);

    await session.closeMcp();
  });

  it("starts no server when mcp.enabled is false", async () => {
    const config = makeConfig({ ...makeMcpConfig(TAG, { fixture: {} }), enabled: false });
    const session = new SessionManager(config, makeStore());

    // No provider is installed, so the lookup cannot reach the manager.
    expect(session.tools.list().map((tool) => tool.name)).not.toContain("mcp__fixture__echo");
    await ready(session);

    expect(pids()).toEqual([]);
    expect(session.listMcpServers()).toEqual([]);
  });

  it("lists the discovered tools with their server and a one-line description", async () => {
    const session = makeSession();

    session.tools.list();
    await ready(session);

    const tools = session.mcpTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "mcp__fixture__echo",
      "mcp__fixture__fail",
      "mcp__fixture__slow",
    ]);
    expect(tools.find((tool) => tool.name === "mcp__fixture__echo")).toEqual({
      name: "mcp__fixture__echo",
      serverId: "fixture",
      description: "Echoes back the given text",
    });
    // Reading the listing never connects: the list does not change.
    expect(session.mcpTools()).toEqual(tools);
    expect(pids()).toHaveLength(1);

    await session.closeMcp();
  });

  it("reloadMcp closes the connections and discovers again from scratch", async () => {
    const session = makeSession();

    session.tools.list();
    await ready(session);

    const first = pids();
    expect(first).toHaveLength(1);

    const servers = await session.reloadMcp();

    expect(servers).toEqual([{ id: "fixture", transport: "stdio", status: "ready", toolCount: 3 }]);
    // The connection was closed, not merely abandoned: the old process is gone
    // and a new one answered the second discovery.
    expect(await waitForDeath(first[0] as number)).toBe(true);
    const second = pids();
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);

    // The tools of the new connection are available again.
    expect(session.tools.list().map((tool) => tool.name)).toContain("mcp__fixture__echo");

    await session.closeMcp();
  });

  it("answers an empty reload for a closed session instead of restarting it", async () => {
    const session = makeSession();

    session.tools.list();
    await ready(session);
    const pid = pids()[0] as number;
    expect(pid).toBeGreaterThan(0);

    await session.closeMcp();
    expect(await waitForDeath(pid)).toBe(true);

    // A reload after the close must not bring a server back: close() is terminal
    // (shutdown calls it), and a process spawned here would be orphaned by the
    // exit that follows.
    expect(await session.reloadMcp()).toEqual([]);
    expect(pids()).toEqual([]);
    expect(session.listMcpServers()).toEqual([]);
  });

  it("closeMcp leaves no server process alive", async () => {
    const session = makeSession();

    session.tools.list();
    await ready(session);

    const pid = pids()[0] as number;
    expect(pid).toBeGreaterThan(0);

    await session.closeMcp();

    expect(await waitForDeath(pid)).toBe(true);
    expect(pids()).toEqual([]);
    expect(session.listMcpServers()).toEqual([]);
  });
});

// A reload after close() must not wake a server: close() is what shutdown()
// calls a moment before the process leaves, and a reload landing in between
// would spawn it back and orphan it.
//
// What this pins is the outcome, not the `isClosed()` guard in `reloadMcp`:
// removing that guard leaves this file green, because `doClose()` empties the
// state the manager discovers from. A test that watched the guard itself would
// have to make a closed manager keep its state, which is not reachable from
// outside.
it("reloadMcp answers empty and starts nothing once the session closed MCP", async () => {
  const session = makeSession();

  session.tools.list();
  await ready(session);
  expect(pids()).toHaveLength(1);

  await session.closeMcp();
  expect(session.mcp.isClosed()).toBe(true);
  expect(pids()).toEqual([]);

  // The outcome under test: no server is discovered again, so nothing is left
  // for process.exit to kill unreported.
  expect(await session.reloadMcp()).toEqual([]);
  expect(pids()).toEqual([]);
});

describe("IHarness.shutdown and MCP", () => {
  // A session that cannot be written must not take the servers with it: they are
  // children of this process, and an exit right after the failure would orphan
  // them. The harness reports the save error, and the close still happens.
  it("closes the MCP servers even when saving the session throws", async () => {
    const config = makeConfig(makeMcpConfig(TAG, { fixture: {} }));
    const harness = createHarness({ config, store: makeStore() });
    const session = (harness as unknown as { session: SessionManager }).session;
    // The write that shutdown() runs, made to fail: it is session.save(), not
    // the store, the one whose failure has to be survivable here.
    vi.spyOn(session, "save").mockImplementation(() => {
      throw new Error("disk full");
    });

    session.tools.list();
    await ready(session);

    const pid = pids()[0] as number;
    expect(pid).toBeGreaterThan(0);

    await expect(harness.shutdown()).rejects.toThrow("disk full");

    // The failure of the save reached the caller, and the server died anyway.
    expect(await waitForDeath(pid)).toBe(true);
    expect(pids()).toEqual([]);
  });

  // Both halves fail: the close of the manager and the write of the session.
 // A `finally` would lose the save error here, because the await of the close
 // rejects while the save error is still in flight and JS drops it. The save
 // is the one that has to arrive: it names the failure the user cares about.
 it("reports the save error when the close fails too", async () => {
 const config = makeConfig(makeMcpConfig(TAG, { fixture: {} }));
 const harness = createHarness({ config, store: makeStore() });
 const session = (harness as unknown as { session: SessionManager }).session;
 vi.spyOn(session, "save").mockImplementation(() => {
 throw new Error("disk full");
 });
 // The real close runs and the manager does shut down, yet the call still
 // rejects: this is the half that used to swallow the save error.
 const realClose = session.mcp.close.bind(session.mcp);
 const close = vi.fn(() => realClose());

 vi.spyOn(session, "closeMcp").mockImplementation(async () => {
 await close();
 throw new Error("close exploded");
 });

 session.tools.list();
 await ready(session);

 await expect(harness.shutdown()).rejects.toThrow("disk full");

 // The close was not skipped because the save threw first, and it did
 // reach the manager.
 expect(close).toHaveBeenCalledTimes(1);
 expect(session.mcp.isClosed()).toBe(true);
 expect(pids()).toEqual([]);
 });

 it("closes the MCP servers before it resolves", async () => {
    const config = makeConfig(makeMcpConfig(TAG, { fixture: {} }));
    const harness = createHarness({ config, store: makeStore() });

    // The public surface connects nothing by itself, so discovery is kicked off
    // through the session the harness owns: the same path a turn takes when it
    // builds the tool list.
    const session = (harness as unknown as { session: SessionManager }).session;
    session.tools.list();
    await ready(session);

    const pid = pids()[0] as number;
    expect(pid).toBeGreaterThan(0);

    await harness.shutdown();

    expect(await waitForDeath(pid)).toBe(true);
    expect(pids()).toEqual([]);
  });
});
