import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import type {
  MemoryCapabilities,
  MemoryContextOptions,
  MemoryHit,
  MemoryObservation,
  MemoryProvider,
  MemoryQuery,
} from "../../src/memory";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import { SessionStore } from "../../src/session/SessionStore";
import type { ApprovalRequest } from "../../src/tools/Tool";
import { logger } from "../../src/utils/logger";

// In-test provider: what is under test is what the manager writes, deletes and
// lists, not how a backend stores it. `inspect` and `recent` are optional on the
// interface, so they are installed per test: the manager branches on whether
// they exist.
class FakeMemoryProvider implements MemoryProvider {
  readonly id = "fake";
  captures: MemoryObservation[] = [];
  observations = new Map<string, MemoryObservation>();
  hits: MemoryHit[] = [];
  searchCalls: { text: string; limit?: number; project?: string }[] = [];
  recentCalls: { limit?: number; project?: string }[] = [];
  forgetCalls: string[] = [];
  forgetReturns = true;
  captureThrows = false;
  inspectThrows = false;
  forgetThrows = false;
  hasForget = true;
  capabilityOverrides: Partial<MemoryCapabilities> = {};
  inspect?: (id: string) => Promise<MemoryObservation | undefined>;
  recent?: (options: { project?: string; limit?: number }) => Promise<MemoryHit[]>;

  capabilities(): MemoryCapabilities {
    return {
      search: true,
      context: true,
      capture: true,
      forget: this.hasForget,
      semantic: false,
      scopes: ["user", "project", "session"],
      ...this.capabilityOverrides,
    };
  }

  async health() {
    return { ok: true };
  }

  async search(query: MemoryQuery): Promise<MemoryHit[]> {
    this.searchCalls.push({ text: query.text, limit: query.limit, project: query.project });

    return this.hits;
  }

  async context(options: MemoryContextOptions): Promise<string> {
    void options;

    return "";
  }

  async capture(observation: MemoryObservation): Promise<{ id: string }> {
    if (this.captureThrows) throw new Error("backend down");
    this.captures.push(observation);
    const id = String(this.captures.length);
    this.observations.set(id, observation);

    return { id };
  }

  async forget(id: string): Promise<boolean> {
    if (this.forgetThrows) throw new Error("backend down");
    this.forgetCalls.push(id);

    return this.forgetReturns;
  }

  async close(): Promise<void> {}
}

// Installs the optional members a real backend of that shape would expose.
const withOptionalOperations = (fake: FakeMemoryProvider) => {
  fake.inspect = async (id: string) => {
    if (fake.inspectThrows) throw new Error("backend down");

    return fake.observations.get(id);
  };
  fake.recent = async (options: { project?: string; limit?: number }) => {
    fake.recentCalls.push({ limit: options.limit, project: options.project });
    const limit = options.limit ?? fake.hits.length;

    return fake.hits.slice(0, limit);
  };

  return fake;
};

let dir: string;
let store: SessionStore;
let fake: FakeMemoryProvider;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "racso-memory-store-"));
  store = new SessionStore(path.join(dir, "sessions"));
  fake = withOptionalOperations(new FakeMemoryProvider());

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

const makeConfig = (memory: Record<string, unknown>, tools: Record<string, unknown> = {}) => {
  const config = {
    providers: { openai: { url: "http://localhost", apikey: "k" } },
    defaultProvider: "openai",
    model: "model",
    memory,
    tools,
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

// Session with the fake planted as the provider, so the store helpers see it.
const initSession = async (
  memory: Record<string, unknown> = { enabled: true, project: "demo" },
  tools: Record<string, unknown> = {},
) => {
  const session = new SessionManager(makeConfig(memory, tools), store);
  const plant = () =>
    Object.defineProperty(session, "memoryProvider", {
      configurable: true,
      get: () => fake,
      set: () => {},
    });

  plant();
  await session.initialize();
  // initialize() rebuilds the provider through the factory, so it is planted
  // again for everything that runs after it.
  plant();

  return session;
};

// The tools receive these helpers through the context; the manager's own
// methods are protected, so the doubled context is the public path to them.
type StoreApi = {
  remember: (input: {
    kind: "fact" | "decision" | "episode" | "preference";
    scope: "user" | "project" | "session";
    title: string;
    content: string;
    topicKey?: string;
  }) => Promise<unknown>;
  forget: (id: string, scope?: "user" | "project" | "session") => Promise<unknown>;
  list: (limit?: number) => Promise<MemoryHit[]>;
};

const storeApi = (session: SessionManager): StoreApi => {
  const internals = session as unknown as {
    rememberMemory: StoreApi["remember"];
    forgetMemory: StoreApi["forget"];
    listMemories: StoreApi["list"];
  };

  return {
    remember: (input) => internals.rememberMemory.call(session, input),
    forget: (id, scope) => internals.forgetMemory.call(session, id, scope),
    list: (limit) => internals.listMemories.call(session, limit),
  };
};

describe("SessionManager memory writes", () => {
  it("redacts secrets before storing the content", async () => {
    const session = await initSession();
    const api = storeApi(session);

    await api.remember({
      kind: "fact",
      scope: "project",
      title: "Deploy key",
      content: "the apikey = sk-abcdef123456 is the one to use",
      topicKey: "deploy.key",
    });

    expect(fake.captures).toHaveLength(1);
    expect(fake.captures[0].content).not.toContain("sk-abcdef123456");
    expect(fake.captures[0].content).toContain("[redacted]");
  });

  it("takes the project and the session id from the manager, not from the input", async () => {
    const session = await initSession();
    const api = storeApi(session);

    await api.remember({
      kind: "fact",
      scope: "project",
      title: "Deploy key",
      content: "content",
      topicKey: "deploy.key",
    });

    expect(fake.captures[0].project).toBe("demo");
    expect(fake.captures[0].sessionId).toBe(session.sessionId);
  });

  it("reports a thrown capture as failed instead of throwing", async () => {
    fake.captureThrows = true;
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const session = await initSession();

    await expect(
      storeApi(session).remember({
        kind: "fact",
        scope: "project",
        title: "T",
        content: "C",
        topicKey: "t.k",
      }),
    ).resolves.toMatchObject({ error: "failed" });
  });

  it("reports unsupported when the backend cannot capture", async () => {
    fake.capabilityOverrides = { capture: false };
    const session = await initSession();

    await expect(
      storeApi(session).remember({
        kind: "fact",
        scope: "project",
        title: "T",
        content: "C",
        topicKey: "t.k",
      }),
    ).resolves.toEqual({ error: "unsupported" });
    expect(fake.captures).toHaveLength(0);
  });
});

describe("SessionManager memory listing", () => {
  it("prefers recent and passes the project and the limit", async () => {
    fake.hits = [
      {
        id: "2",
        kind: "decision",
        scope: "project",
        title: "Newest",
        content: "b",
      },
      { id: "1", kind: "fact", scope: "project", title: "Older", content: "a" },
    ];
    const session = await initSession();

    const hits = await storeApi(session).list(1);

    expect(hits.map((hit) => hit.title)).toEqual(["Newest"]);
    expect(fake.recentCalls[0]).toEqual({ limit: 1, project: "demo" });
    expect(fake.searchCalls).toHaveLength(0);
  });

  it("degrades to an empty search when the backend has no recent", async () => {
    fake.recent = undefined;
    fake.hits = [{ id: "1", kind: "fact", scope: "project", title: "Only", content: "a" }];
    const session = await initSession();

    const hits = await storeApi(session).list(3);

    expect(hits.map((hit) => hit.title)).toEqual(["Only"]);
    expect(fake.searchCalls[0]).toMatchObject({ text: "", limit: 3, project: "demo" });
  });
});

describe("SessionManager memory deletes", () => {
  const capture = async (session: SessionManager, scope: "user" | "project" | "session") => {
    await storeApi(session).remember({
      kind: "fact",
      scope,
      title: "T",
      content: "C",
      topicKey: "t.k",
    });

    return String(fake.captures.length);
  };

  it("deletes a memory of this project and reports ok", async () => {
    const session = await initSession();
    const id = await capture(session, "project");

    await expect(storeApi(session).forget(id, "project")).resolves.toEqual({
      forgotten: true,
      reason: "ok",
    });
    expect(fake.forgetCalls).toEqual([id]);
  });

  it("maps a missing id to not-found without calling forget", async () => {
    const session = await initSession();

    await expect(storeApi(session).forget("999", "project")).resolves.toEqual({
      forgotten: false,
      reason: "not-found",
    });
    expect(fake.forgetCalls).toHaveLength(0);
  });

  it("maps a memory of another project to out-of-scope", async () => {
    fake.observations.set("1", {
      kind: "fact",
      scope: "project",
      title: "T",
      content: "C",
      project: "another-project",
    });
    const session = await initSession();

    await expect(storeApi(session).forget("1", "project")).resolves.toEqual({
      forgotten: false,
      reason: "out-of-scope",
    });
    expect(fake.forgetCalls).toHaveLength(0);
  });

  it("maps a delete the backend refuses to failed", async () => {
    const session = await initSession();
    const id = await capture(session, "project");
    fake.forgetReturns = false;

    await expect(storeApi(session).forget(id, "project")).resolves.toEqual({
      forgotten: false,
      reason: "failed",
    });
  });

  it("reports unsupported when the backend cannot forget", async () => {
    fake.hasForget = false;
    const session = await initSession();

    await expect(storeApi(session).forget("1", "project")).resolves.toEqual({
      forgotten: false,
      reason: "unsupported",
    });
  });

  it("reports unsupported when the backend cannot inspect", async () => {
    fake.inspect = undefined;
    const session = await initSession();

    await expect(storeApi(session).forget("1", "project")).resolves.toEqual({
      forgotten: false,
      reason: "unsupported",
    });
  });

  it("does not propagate an exception from the backend", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    fake.inspectThrows = true;
    const session = await initSession();

    await expect(storeApi(session).forget("1", "project")).resolves.toEqual({
      forgotten: false,
      reason: "failed",
    });
  });
});

// The approval gate is the only thing between a hallucinated id and a delete, so
// its shape and its order are part of the contract: a "write" request naming the
// exact id, asked BEFORE the provider forgets.
describe("SessionManager memory delete approval", () => {
  const capture = async (session: SessionManager) => {
    await storeApi(session).remember({
      kind: "fact",
      scope: "project",
      title: "T",
      content: "C",
      topicKey: "t.k",
    });

    return String(fake.captures.length);
  };

  it("asks for a write approval naming the id before deleting", async () => {
    const session = await initSession(undefined, { approval: "ask" });
    const id = await capture(session);
    const requests: ApprovalRequest[] = [];
    // The flag records that the handler answered; it is checked next to the
    // provider log so a gate moved after the delete cannot pass.
    let answered = false;
    session.approveWith(async (request) => {
      requests.push(request);
      answered = true;

      return "allow";
    });

    await expect(storeApi(session).forget(id, "project")).resolves.toEqual({
      forgotten: true,
      reason: "ok",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      tool: "forget",
      kind: "write",
      subject: `memory:${id}`,
    });
    expect(fake.forgetCalls).toEqual([id]);
    expect(answered).toBe(true);
  });

  it("does not delete when the handler denies", async () => {
    const session = await initSession(undefined, { approval: "ask" });
    const id = await capture(session);
    session.approveWith(async () => "deny");

    await expect(storeApi(session).forget(id, "project")).resolves.toEqual({
      forgotten: false,
      reason: "failed",
    });
    expect(fake.forgetCalls).toHaveLength(0);
  });

  it("deletes nothing and asks nothing when the id is unknown or out of scope", async () => {
    fake.observations.set("2", {
      kind: "fact",
      scope: "project",
      title: "T",
      content: "C",
      project: "another-project",
    });
    const session = await initSession(undefined, { approval: "ask" });
    const handler = vi.fn(async () => "allow" as const);
    session.approveWith(handler);

    await expect(storeApi(session).forget("999", "project")).resolves.toMatchObject({
      reason: "not-found",
    });
    await expect(storeApi(session).forget("2", "project")).resolves.toMatchObject({
      reason: "out-of-scope",
    });

    // A request for something that cannot be deleted never reaches the user.
    expect(handler).not.toHaveBeenCalled();
    expect(fake.forgetCalls).toHaveLength(0);
  });
});
