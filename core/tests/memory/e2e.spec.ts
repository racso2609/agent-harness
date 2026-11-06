import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import { MEMORY_BLOCK_PREFIX, type MemoryHit } from "../../src/memory";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import { SessionStore } from "../../src/session/SessionStore";
import type { ChatResult, History } from "../../src/types/providers";

// End to end: the real SessionManager and the real LocalMemoryProvider (a
// throwaway SQLite file). Only the chat backend is faked, since tests cannot
// reach the network. Everything else -- compaction, capture, redaction,
// project scoping, injection and recall -- runs as it does in production.

let dir: string;
let dbPath: string;
// Providers built by the sessions under test, closed in afterEach: a live
// SQLite handle keeps the file open and the temporary directory unremovable.
let open: { close(): Promise<void> }[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-e2e-"));
  dbPath = path.join(dir, "memory.db");
  open = [];

  vi.stubEnv("RACSO_HARNESS_AGENTS_LOCATION", path.join(dir, "agents"));
  vi.stubEnv("RACSO_HARNESS_SKILLS_LOCATION", path.join(dir, "skills"));
});

afterEach(async () => {
  for (const provider of open) await provider.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const makeConfig = (project = "e2e-demo") => {
  const config = {
    providers: { openai: { url: "http://localhost", apikey: "k" } },
    defaultProvider: "openai",
    model: "model",
    // Two messages per turn, so a threshold of 2 folds older turns into memory.
    compactThreshold: 2,
    // Pins the workspace: project resolution then never depends on the
    // repository the test runner happens to live in.
    tools: { workspace: dir },
    memory: {
      enabled: true,
      provider: "local",
      path: dbPath,
      project,
      captureOnCompact: true,
      injectOnStart: true,
    },
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

// Deterministic chat backend: the classifier gets its JSON, every other turn
// echoes a canned answer, so the conversation advances with known text.
const fakeChat = () => {
  const provider = new OpenAiProvider("http://localhost", "k", "model");

  provider.initialize = vi.fn(async () => {});
  provider.setModel = vi.fn(() => true);
  provider.getModel = () => "model";
  // A context window far larger than anything this conversation produces, so
  // maybeAutoCompact() never fires mid-conversation: the test drives
  // compaction explicitly and sees exactly one fold.
  provider.getContextWindow = () => 1_000_000;
  provider.chat = (async (messages: History[]) => {
    const prompt = messages[messages.length - 1]?.content ?? "";
    const text = prompt.includes("is_image_generation")
      ? '{"is_image_generation": false}'
      : `assistant acknowledges: ${prompt}`;

    return {
      turn: { text, toolCalls: [], finishReason: "stop" as const },
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    } as ChatResult;
  }) as OpenAiProvider["chat"];

  return provider;
};

// A session wired to the real memory backend. initialize() builds its chat
// provider through this factory, so replacing it is what keeps the test off
// the network; the memory provider still comes from config, and is real.
const newSession = async (project = "e2e-demo") => {
  const store = new SessionStore(path.join(dir, "sessions"));
  const session = new SessionManager(makeConfig(project), store);
  session["createProvider"] = (() => fakeChat()) as unknown as (typeof session)["createProvider"];
  await session.initialize();

  open.push(session["memoryProvider"]);

  return session;
};

const memoryBlocks = (session: SessionManager) =>
  session.history.filter(
    (message) => message.role === "system" && message.content.startsWith(MEMORY_BLOCK_PREFIX),
  );

const dialogue = (session: SessionManager) =>
  session.history.filter((message) => message.role !== "system");

// Reads the SQLite file directly: what matters is what landed on disk, not
// what the provider believes it stored.
const rows = () => {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT kind, scope, project, title, content FROM observations").all() as {
      kind: string;
      scope: string;
      project: string;
      title: string;
      content: string;
    }[];
  } finally {
    db.close();
  }
};

// Four turns, each adding a user and an assistant message: eight messages in
// all, above the threshold of 2, so there is a conversation to fold.
const converse = async (session: SessionManager) => {
  await session.ask("We decided to store project notes in node:sqlite for the local backend.");
  await session.ask("Next, migrations run on startup behind a schema version check.");
  await session.ask("Finally, search uses FTS5 with OR-joined terms from the query.");
  await session.ask("Never put secrets in memory, redaction handles api keys.");
};

describe("memory end to end", () => {
  it("remembers across sessions what compaction folded away", async () => {
    // Session A: a conversation long enough to be compacted for real.
    const a = await newSession();
    await converse(a);
    expect(dialogue(a)).toHaveLength(8);
    expect(await a.compactSession()).toBe(true);

    // 1. A wrote a real observation to the real database, scoped to the project.
    const stored = rows();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]).toMatchObject({ kind: "episode", scope: "project", project: "e2e-demo" });
    expect(stored[0].content).toContain("node:sqlite");

    // 2. Session B starts from scratch: new manager, same database, same project.
    const b = await newSession();

    const blocks = memoryBlocks(b);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toContain("node:sqlite");
    // Injected right after the persona, so the agent reads it before the turn.
    expect(b.history[0].role).toBe("system");
    expect(b.history[0].content).not.toContain(MEMORY_BLOCK_PREFIX);
    expect(b.history[1]).toBe(blocks[0]);
    // B has no conversation of its own yet: nothing leaked across sessions.
    expect(dialogue(b)).toHaveLength(0);
  });

  it("recall finds what a previous session stored", async () => {
    const a = await newSession();
    await converse(a);
    await a.compactSession();

    const b = await newSession();
    const tool = b.tools.list().find((candidate) => candidate.name === "recall");
    expect(tool).toBeDefined();

    const result = await tool!.execute(
      {
        cwd: dir,
        sessionId: b.sessionId,
        approve: async () => "allow",
        recallMemory: (query: string, limit?: number) => b["recallMemory"](query, limit),
      },
      { query: "node:sqlite" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("[episode]");
    expect(result.output).toContain("node:sqlite");
  });

  it("scopes recall to the project of the running session", async () => {
    const a = await newSession();
    await converse(a);
    await a.compactSession();

    // Same database, different project key: neither the block nor a search may
    // cross over. This is what keeps two workspaces from reading each other.
    const other = await newSession("another-project");

    expect(memoryBlocks(other)).toHaveLength(0);

    const hits = (await other["recallMemory"]("node:sqlite")) as MemoryHit[];
    expect(hits).toHaveLength(0);
  });
});
