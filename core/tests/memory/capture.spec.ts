import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import type {
  MemoryContextOptions,
  MemoryHit,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
} from "../../src/memory";
import { redact } from "../../src/memory/redact";
import { OpenAiProvider } from "../../src/providers/openai";
import { compactHistory, compactHistoryWithSummary } from "../../src/session/history";
import { SessionManager } from "../../src/session/SessionManager";
import { SessionStore } from "../../src/session/SessionStore";
import type { History } from "../../src/types/providers";
import { logger } from "../../src/utils/logger";

// In-test provider: what is under test is what the manager captures, not how a
// backend stores it.
class FakeMemoryProvider implements MemoryProvider {
  readonly id = "fake";
  captures: MemoryObservation[] = [];
  captureThrows = false;

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

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    void query;

    return [];
  }

  async context(options: MemoryContextOptions) {
    void options;

    return "";
  }

  async capture(observation: MemoryObservation) {
    this.captures.push(observation);
    if (this.captureThrows) throw new Error("backend down");

    return { id: String(this.captures.length) };
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-capture-"));
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

// Session with the fake planted for the whole test, so compactSession() sees it
// too, not only initialize().
const initSession = async (memory: Record<string, unknown>) => {
  const session = new SessionManager(makeConfig(memory), store);
  await withFakeProvider(session, () => session.initialize());
  Object.defineProperty(session, "memoryProvider", {
    configurable: true,
    get: () => fake,
    set: () => {},
  });

  return session;
};

const conversation = (...contents: string[]): History[] =>
  contents.map((content) => ({ role: "user" as const, content }));

describe("compactSession capture", () => {
  it("captures the folded window once, titled from the first old user turn", async () => {
    const session = await initSession({ enabled: true, project: "demo" });
    session.history = conversation("u1", "u2", "u3", "u4", "u5", "u6");

    await expect(session.compactSession()).resolves.toBe(true);

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0].content).toContain("u1");
    // The title comes from olderMessages[0]; the compacted history starts with the
    // recent window, whose first user is u3.
    expect(fake.captures[0].title).toBe("u1");
    expect(fake.captures[0].kind).toBe("episode");
    expect(fake.captures[0].scope).toBe("project");
    expect(fake.captures[0].project).toBe("demo");
    expect(fake.captures[0].sessionId).toBe(session.sessionId);
    expect(session.history[0].content).toContain("[Memoria previa compactada]");
    expect(session.history[1]).toMatchObject({ role: "user", content: "u3" });
  });

  it("redacts secrets before storing the summary", async () => {
    const session = await initSession({ enabled: true });
    session.history = conversation("apikey=abc12345", "u2", "u3", "u4", "u5", "u6");

    await session.compactSession();

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0].content).not.toContain("abc12345");
    expect(fake.captures[0].content).toContain("[redacted]");
  });

  it("redacts secrets in the title, not only in the summary", async () => {
    const session = await initSession({ enabled: true });
    session.history = conversation("apikey=abcdef123456", "u2", "u3", "u4", "u5", "u6");

    await session.compactSession();

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0].title).not.toContain("abcdef123456");
    expect(fake.captures[0].title).toContain("[redacted]");
  });
  it("falls back to a fixed title when the folded window has no user turn", async () => {
    const session = await initSession({ enabled: true });
    session.history = [
      { role: "system", content: "persona" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
    ];

    await session.compactSession();

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0].title).toBe("Compacted session");
  });

  it("does not break compaction when capture throws", async () => {
    fake.captureThrows = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = await initSession({ enabled: true });
    session.history = conversation("u1", "u2", "u3", "u4", "u5", "u6");

    await expect(session.compactSession()).resolves.toBe(true);

    expect(fake.captures).toHaveLength(1);
    expect(session.history).toHaveLength(5);
    expect(session.history[0].content).toContain("[Memoria previa compactada]");
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining("Memory capture on compact failed"),
    );
  });

  it("honours captureOnCompact: false", async () => {
    const session = await initSession({ enabled: true, captureOnCompact: false });
    session.history = conversation("u1", "u2", "u3", "u4", "u5", "u6");

    await expect(session.compactSession()).resolves.toBe(true);

    expect(fake.captures).toHaveLength(0);
    expect(session.history).toHaveLength(5);
  });

  it("captures nothing when memory is disabled", async () => {
    const session = await initSession({ enabled: false });
    session.history = conversation("u1", "u2", "u3", "u4", "u5", "u6");

    await expect(session.compactSession()).resolves.toBe(true);

    expect(fake.captures).toHaveLength(0);
  });

  it("captures nothing and returns false when nothing is compacted", async () => {
    const session = await initSession({ enabled: true });
    session.history = conversation("u1", "u2");

    await expect(session.compactSession()).resolves.toBe(false);

    expect(fake.captures).toHaveLength(0);
    expect(session.history).toHaveLength(2);
  });
});

describe("compactHistoryWithSummary", () => {
  it("returns the same array reference when nothing is compacted", () => {
    const history = conversation("u1", "u2", "u3", "u4");

    const result = compactHistoryWithSummary(history);

    expect(result.history).toBe(history);
    expect(result.summary).toBe("");
    expect(result.title).toBe("");
  });

  it("returns the folded summary and the title of the older window", () => {
    const history = conversation("u1", "u2", "u3", "u4", "u5", "u6");

    const result = compactHistoryWithSummary(history);

    expect(result.history).toEqual(compactHistory(history));
    expect(result.summary).toBe("user: u1 | user: u2");
    expect(result.title).toBe("u1");
  });

  it("truncates a long title", () => {
    const long = "x".repeat(150);
    const history = conversation(long, "u2", "u3", "u4", "u5", "u6");

    const result = compactHistoryWithSummary(history);

    expect(result.title).toBe(`${"x".repeat(100)}…`);
  });
});

describe("redact", () => {
  it("hides an sk- key", () => {
    expect(redact("key sk-abc123")).not.toContain("sk-abc123");
  });

  it("hides Bearer headers, assignments and AWS keys", () => {
    expect(redact("Authorization: Bearer abcdefgh1234")).toBe("Authorization: Bearer [redacted]");
    expect(redact("apikey=supersecret")).toBe("apikey=[redacted]");
    expect(redact("api_key: supersecret")).toBe("api_key: [redacted]");
    expect(redact("token=abcdef")).toBe("token=[redacted]");
    expect(redact("password=hunter2")).toBe("password=[redacted]");
    expect(redact("secret=hello1")).toBe("secret=[redacted]");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "We chose node:sqlite for the local store; sk-learn comes up often.";

    expect(redact(text)).toBe(text);
  });

  it("is idempotent", () => {
    const text = "key sk-abc123 Bearer abcdefgh1234 apikey=supersecret AKIAIOSFODNN7EXAMPLE";
    const once = redact(text);

    expect(redact(once)).toBe(once);
  });
});
