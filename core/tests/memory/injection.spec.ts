import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import {
  MEMORY_BLOCK_PREFIX,
  type MemoryContextOptions,
  type MemoryHit,
  type MemoryProvider,
  type MemoryQuery,
} from "../../src/memory";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import { SessionStore } from "../../src/session/SessionStore";
import { logger } from "../../src/utils/logger";
import type { ToolContext } from "../../src/tools/Tool";

// In-test provider: what is under test is what the manager does with the
// context, not how a backend produces it.
class FakeMemoryProvider implements MemoryProvider {
  readonly id = "fake";
  contextText = "X";
  contextThrows = false;
  hits: MemoryHit[] = [];
  searchThrows = false;
  contextCalls = 0;
  searchCalls: { text: string; limit?: number; project?: string }[] = [];

  capabilities() {
    return {
      search: true,
      context: true,
      capture: true,
      forget: true,
      semantic: false,
      scopes: ["project" as const],
    };
  }

  async health() {
    return { ok: true };
  }

  async search(query: MemoryQuery) {
    this.searchCalls.push({
      text: query.text,
      limit: query.limit,
      project: query.project,
    });
    if (this.searchThrows) throw new Error("backend down");

    return this.hits;
  }

  async context(options: MemoryContextOptions) {
    void options;
    this.contextCalls += 1;
    if (this.contextThrows) throw new Error("backend down");

    return this.contextText;
  }

  async capture() {
    return { id: "1" };
  }

  async forget() {
    return true;
  }

  async close() {}
}

let dir: string;
let store: SessionStore;
let fake: FakeMemoryProvider;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-injection-"));
  store = new SessionStore(path.join(dir, "sessions"));
  fake = new FakeMemoryProvider();

  vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
  vi.spyOn(OpenAiProvider.prototype, "getModel").mockReturnValue("model");
  // load() resumes through setModel, which refuses an empty catalogue.
  vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
  vi.stubEnv("RACSO_HARNESS_AGENTS_LOCATION", path.join(dir, "agents"));
  vi.stubEnv("RACSO_HARNESS_SKILLS_LOCATION", path.join(dir, "skills"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeConfig = (memory: Record<string, unknown>) => {
  const config = {
    providers: { openai: { url: "http://localhost", apikey: "k" } },
    defaultProvider: "openai",
    model: "model",
    memory,
  };

  return {
    config,
    listProviders: () => Object.keys(config.providers),
    listProviderDetails: () => [],
    configureProvider: vi.fn(),
    removeProvider: vi.fn(),
    writeConfig: vi.fn(),
  } as unknown as Config;
};

// initialize() builds its provider through the factory, so the fake is
// planted as an own property for the duration of one call.
const withFakeProvider = async <T>(session: SessionManager, run: () => Promise<T>): Promise<T> => {
  const original = Object.getOwnPropertyDescriptor(session, "memoryProvider");
  Object.defineProperty(session, "memoryProvider", {
    configurable: true,
    get: () => fake,
    set: () => {},
  });

  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(session, "memoryProvider", original);
  }
};

const initSession = async (
  memory: Record<string, unknown>,
  options: { sessionId?: string } = {},
) => {
  const session = new SessionManager(makeConfig(memory), store);
  await withFakeProvider(session, () => session.initialize(options));

  return session;
};

// Session whose searches go through the fake, for the recall tool tests.
const liveSession = async (memory: Record<string, unknown>) => {
  const session = await initSession(memory);
  Object.defineProperty(session, "memoryProvider", {
    configurable: true,
    get: () => fake,
    set: () => {},
  });

  return session;
};

const memoryBlocks = (session: SessionManager) =>
  session.history.filter(
    (message) => message.role === "system" && message.content.startsWith(MEMORY_BLOCK_PREFIX),
  );

describe("SessionManager memory injection", () => {
  it("injects the block right after the persona on a new session", async () => {
    const session = await initSession({ enabled: true, injectOnStart: true });

    expect(session.history[0].role).toBe("system");
    expect(session.history[0].content).not.toContain(MEMORY_BLOCK_PREFIX);
    expect(session.history[1].role).toBe("system");
    expect(session.history[1].content).toContain(MEMORY_BLOCK_PREFIX);
    expect(session.history[1].content).toContain("X");
    expect(session.history).toHaveLength(2);
  });

  it("is idempotent on the new-session branch", async () => {
    const session = new SessionManager(makeConfig({ enabled: true }), store);

    await withFakeProvider(session, () => session.initialize());
    await withFakeProvider(session, () => session.initialize());

    expect(fake.contextCalls).toBe(2);
    expect(memoryBlocks(session)).toHaveLength(1);
  });

  it("is idempotent when resuming a session", async () => {
    const first = await initSession({ enabled: true });
    first.save();

    const resumed = await initSession({ enabled: true }, { sessionId: first.sessionId });

    expect(memoryBlocks(resumed)).toHaveLength(1);
    expect(resumed.history[0].content).not.toContain(MEMORY_BLOCK_PREFIX);
    expect(resumed.history[1].content).toContain("X");
  });

  it("does not duplicate the block on a record that already carries it", async () => {
    const first = await initSession({ enabled: true });
    first.save();

    // Reopen twice: the second record already holds the block.
    const second = await initSession({ enabled: true }, { sessionId: first.sessionId });
    second.save();

    const third = await initSession({ enabled: true }, { sessionId: second.sessionId });

    expect(memoryBlocks(third)).toHaveLength(1);
  });

  it("leaves the history untouched when memory is disabled", async () => {
    const session = await initSession({ enabled: false });

    expect(fake.contextCalls).toBe(0);
    expect(memoryBlocks(session)).toHaveLength(0);
    expect(session.history).toHaveLength(1);
  });

  it("survives a provider whose context throws", async () => {
    fake.contextThrows = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = new SessionManager(makeConfig({ enabled: true }), store);

    await expect(withFakeProvider(session, () => session.initialize())).resolves.toBeUndefined();

    expect(fake.contextCalls).toBe(1);
    expect(memoryBlocks(session)).toHaveLength(0);
    expect(session.history).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("Memory context injection failed"),
    );
  });

  it("injects nothing when the provider returns a blank context", async () => {
    fake.contextText = "   ";
    const session = await initSession({ enabled: true });

    expect(memoryBlocks(session)).toHaveLength(0);
    expect(session.history).toHaveLength(1);
  });

  it("honours injectOnStart: false", async () => {
    const session = await initSession({ enabled: true, injectOnStart: false });

    expect(fake.contextCalls).toBe(0);
    expect(memoryBlocks(session)).toHaveLength(0);
  });
});

describe("recall tool", () => {
  const recallTool = (session: SessionManager) =>
    session.tools.list().find((tool) => tool.name === "recall");

  const ctx = (session: SessionManager): ToolContext => ({
    cwd: process.cwd(),
    sessionId: session.sessionId,
    approve: async () => "allow",
    recallMemory: (query, limit) => session.searchMemory(query, limit),
  });

  it("returns the hits as readable text", async () => {
    fake.hits = [
      {
        id: "1",
        kind: "decision",
        scope: "project",
        title: "Use sqlite",
        content: "We chose node:sqlite for the local store.",
      },
    ];
    const session = await liveSession({ enabled: true, project: "demo" });

    const result = await recallTool(session)!.execute(ctx(session), {
      query: "sqlite",
      limit: 3,
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("[decision]");
    expect(result.output).toContain("Use sqlite");
    expect(result.output).toContain("We chose node:sqlite");
    expect(fake.searchCalls[0]).toMatchObject({ text: "sqlite", limit: 3, project: "demo" });
  });

  it("reports an empty result without an error", async () => {
    const session = await liveSession({ enabled: true });

    const result = await recallTool(session)!.execute(ctx(session), { query: "nothing" });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('No memories found for: "nothing"');
  });

  it("keeps the turn going when the provider throws", async () => {
    fake.searchThrows = true;
    const session = await liveSession({ enabled: true });

    // recallMemory swallows the backend failure, so the tool sees "not
    // found" instead of an error and the turn is not aborted.
    const result = await recallTool(session)!.execute(ctx(session), { query: "anything" });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("No memories found");
  });

  it("reports an error when the tool itself receives a throwing backend", async () => {
    const { RecallTool } = await import("../../src/tools/recall");
    const result = await new RecallTool().execute(
      {
        cwd: process.cwd(),
        sessionId: "s",
        approve: async () => "allow",
        recallMemory: async () => {
          throw new Error("backend down");
        },
      },
      { query: "x" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("backend down");
  });

  it("reports an error when memory is not wired", async () => {
    const { RecallTool } = await import("../../src/tools/recall");
    const result = await new RecallTool().execute(
      { cwd: process.cwd(), sessionId: "s", approve: async () => "allow" },
      { query: "x" },
    );

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not available/);
  });

  it("is registered for an agent without an allowlist", async () => {
    const session = await liveSession({ enabled: true });

    expect(session.tools.list().map((tool) => tool.name)).toContain("recall");
  });

  it("is not offered to an agent with an allowlist", async () => {
    const session = await liveSession({ enabled: true });
    session.agentRegistry.register({
      id: "limited",
      name: "Limited",
      personality: "Read only.",
      tools: ["readFile"],
    });
    expect(await session.setAgent("limited")).toBe(true);

    const names = session.tools.list().map((tool) => tool.name);
    expect(names).toContain("readFile");
    expect(names).not.toContain("recall");
  });

  it("is not registered when memory is disabled", async () => {
    const session = await initSession({ enabled: false });

    expect(session.tools.list().map((tool) => tool.name)).not.toContain("recall");
  });
});
