import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../src/types/providers";
import type { Config } from "../../src/configuration";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import type { SessionStore } from "../../src/session/SessionStore";
import type { SpawnHandle } from "../../src/session/spawn";

const makeConfig = (overrides: Record<string, unknown> = {}) => {
  const config = { providers: {}, ...overrides };

  return {
    config,
    // Mirrors the Config helpers SessionManager delegates to.
    listProviders: () => Object.keys(config.providers),
    listProviderDetails: () =>
      Object.entries(config.providers).map(([id, provider]) => ({
        id,
        type: "openai",
        ...(provider as object),
        isDefault: false,
      })),
    configureProvider: vi.fn(),
    removeProvider: vi.fn(),
    writeConfig: vi.fn(),
  } as unknown as Config;
};

const makeStore = () =>
  ({
    save: vi.fn(),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
  }) as unknown as SessionStore;

const stopTurn = (
  text = "ok",
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  costUsd?: number,
) => ({
  turn: {
    text,
    toolCalls: [],
    finishReason: "stop" as const,
  },
  usage,
  costUsd,
});

describe("SessionManager status", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    provider.getContextWindow = () => 1000;
    provider.getContextTokens = () => 900;
    store = makeStore();
  });

  it("starts with zero usage and cost", () => {
    const session = new SessionManager(makeConfig(), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";

    expect(session.status()).toMatchObject({
      sessionId: session.sessionId,
      provider: "openai",
      model: "model",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      contextTokens: 900,
      contextWindow: 1000,
      contextUsage: 0.9,
      autoCompact: true,
      autoCompactThreshold: 60,
    });
  });

  it("accumulates token usage and cost across prompts", async () => {
    const session = new SessionManager(makeConfig({ autoCompact: false }), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    provider.chat = vi.fn(async () =>
      stopTurn("ok", { promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 0.25),
    );

    await session.ask("first");
    await session.ask("second");

    expect(session.status().usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
    expect(session.status().costUsd).toBeCloseTo(0.5);
  });

  it("auto-compacts when context reaches the configured threshold", async () => {
    const session = new SessionManager(
      makeConfig({ autoCompact: true, autoCompactThreshold: 80, compactThreshold: 2 }),
      store,
    );
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    session.history = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
    ];
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    provider.chat = vi.fn(async () => stopTurn());

    await session.ask("hello");

    expect(session.history).toEqual([
      {
        role: "system",
        content:
          "[Memoria previa compactada]: user: u1 | user: u2 | user: u3 | user: u4 | user: u5 | user: u6",
      },
      { role: "user", content: "hello" },
      { role: "assistant", content: "ok" },
    ]);
  });

  it("does not auto-compact below the configured threshold", async () => {
    const session = new SessionManager(
      makeConfig({ autoCompact: true, autoCompactThreshold: 95, compactThreshold: 2 }),
      store,
    );
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    session.history = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
    ];
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    provider.chat = vi.fn(async () => stopTurn());

    await session.ask("hello");

    expect(session.history).toHaveLength(6);
  });
});

describe("SessionManager agent definition", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    store = makeStore();
  });

  const makeSession = (overrides: Record<string, unknown> = {}) => {
    const session = new SessionManager(makeConfig({ autoCompact: false, ...overrides }), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    return session;
  };

  it("injects the agent persona as the first system message", async () => {
    const session = makeSession();
    session.agent = {
      id: "reviewer",
      name: "Reviewer",
      personality: "Only review code.",
    };
    session.agentId = "reviewer";
    session["applySystemPrompt"]();
    provider.chat = vi.fn(async () => stopTurn("ok"));

    await session.ask("hi");

    expect(session.history[0]).toMatchObject({ role: "system" });
    expect(session.history[0].content).toContain("Only review code.");
  });

  it("tightens approval using the agent policy", async () => {
    const session = makeSession({ tools: { approval: "auto" } });
    session.agent = {
      id: "safe",
      name: "Safe",
      personality: "x",
      approval: "deny",
    };

    await expect(
      session["approve"]({ tool: "shell", kind: "exec", subject: "rm -rf /" }),
    ).resolves.toBe("deny");
  });

  it("allows reads without prompting in every mode", async () => {
    const session = makeSession({ tools: { approval: "deny" } });

    await expect(
      session["approve"]({ tool: "readFile", kind: "read", subject: "/x" }),
    ).resolves.toBe("allow");
  });

  it("allows exec in auto mode without prompting", async () => {
    const session = makeSession({ tools: { approval: "auto" } });

    await expect(
      session["approve"]({
        tool: "shell",
        kind: "exec",
        subject: "git push origin main",
      }),
    ).resolves.toBe("allow");
  });

  it("remembers an 'always' answer for the session", async () => {
    const session = makeSession({ tools: { approval: "ask" } });
    const handler = vi.fn(async () => "always" as const);
    session.approveWith(handler);
    const request = {
      tool: "writeFile",
      kind: "write" as const,
      subject: "/x/file.txt",
    };

    await expect(session["approve"](request)).resolves.toBe("allow");
    await expect(session["approve"](request)).resolves.toBe("allow");

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("denies a write in ask mode when the handler says no", async () => {
    const session = makeSession({ tools: { approval: "ask" } });
    session.approveWith(vi.fn(async () => "deny" as const));

    await expect(
      session["approve"]({ tool: "writeFile", kind: "write", subject: "/x" }),
    ).resolves.toBe("deny");
  });

  it("denies writes in ask mode when no approval handler is installed", async () => {
    const session = makeSession({ tools: { approval: "ask" } });

    await expect(
      session["approve"]({ tool: "writeFile", kind: "write", subject: "/x" }),
    ).resolves.toBe("deny");
  });

  it("lowers maxIterations to the agent cap", async () => {
    const session = makeSession({ tools: { maxIterations: 8 } });
    session.agent = {
      id: "quick",
      name: "Quick",
      personality: "x",
      maxIterations: 2,
    };
    session.tools.register({
      name: "loop",
      description: "loop",
      parameters: { type: "object" },
      execute: vi.fn(async () => ({ output: "again" })),
    });
    provider.chat = vi.fn(async () => ({
      turn: {
        text: "",
        toolCalls: [{ id: "c", name: "loop", args: {} }],
        finishReason: "toolCalls" as const,
      },
    }));

    await session.ask("spin");

    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("reports the active agent in status", () => {
    const session = makeSession();
    session.agentId = "reviewer";

    expect(session.status().agent).toBe("reviewer");
  });

  it("switches agent tools when changing agent", async () => {
    const session = makeSession();
    session["agentsLoaded"] = true;
    session.agentRegistry.register({
      id: "reader",
      name: "Reader",
      personality: "read only",
      tools: ["readFile"],
    });

    const changed = await session.setAgent("reader");

    expect(changed).toBe(true);
    expect(session.status().agent).toBe("reader");
    expect(session.tools.list().map((tool) => tool.name)).toEqual(["readFile"]);
  });

  it("switches the effective provider and model when changing agent", async () => {
    const session = makeSession({
      providers: { openai: { url: "https://api.example.com", apikey: "key" } },
    });
    const created: Array<{ provider: string; model: string }> = [];
    session["createProvider"] = ((name: string, _config: unknown, model: string) => {
      created.push({ provider: name, model });
      const fake = new OpenAiProvider("https://api.example.com", "key", model);
      fake.initialize = vi.fn(async () => {});
      fake.setModel = vi.fn(() => true);
      fake.getModel = () => model;
      return fake;
    }) as unknown as (typeof session)["createProvider"];
    session["agentsLoaded"] = true;
    session.agentRegistry.register({
      id: "coder",
      name: "Coder",
      personality: "code",
      model: "cheap-model",
    });

    const changed = await session.setAgent("coder");

    expect(changed).toBe(true);
    expect(created).toEqual([{ provider: "openai", model: "cheap-model" }]);
    expect(session.status()).toMatchObject({
      agent: "coder",
      provider: "openai",
      model: "cheap-model",
    });
  });

  it("falls back to the current model when the agent has no override", async () => {
    const session = makeSession({
      providers: { openai: { url: "https://api.example.com", apikey: "key" } },
    });
    const created: Array<{ provider: string; model: string }> = [];
    session["createProvider"] = ((name: string, _config: unknown, model: string) => {
      created.push({ provider: name, model });
      const fake = new OpenAiProvider("https://api.example.com", "key", model);
      fake.initialize = vi.fn(async () => {});
      fake.setModel = vi.fn(() => true);
      fake.getModel = () => model;
      return fake;
    }) as unknown as (typeof session)["createProvider"];
    session["agentsLoaded"] = true;
    session.agentRegistry.register({
      id: "plain",
      name: "Plain",
      personality: "x",
    });

    const changed = await session.setAgent("plain");

    expect(changed).toBe(true);
    expect(created).toEqual([]);
    expect(session.status().model).toBe("model");
  });

  it("keeps compacted memory when applying a new persona", async () => {
    const session = makeSession();
    session.history = [{ role: "system", content: "compacted memory" }];
    session.agent = {
      id: "reviewer",
      name: "Reviewer",
      personality: "new persona",
    };

    session["applySystemPrompt"](true);

    expect(session.history[0].content).toContain("new persona");
    expect(session.history).toHaveLength(1);
  });
});

describe("SessionManager stored sessions", () => {
  const record = (id: string, content = "hello") => ({
    id,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    provider: "openai",
    model: "model",
    history: [
      { role: "system" as const, content: "persona" },
      { role: "user" as const, content },
    ],
  });

  const makeSession = (records: ReturnType<typeof record>[]) => {
    const store = makeStore();
    store.list = vi.fn(() => records) as unknown as SessionStore["list"];
    const session = new SessionManager(makeConfig(), store);
    session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
    session.providerName = "openai";
    session.model = "model";
    return session;
  };

  it("summarizes stored sessions with a title and message count", () => {
    const session = makeSession([record("session-1", "hello world")]);

    expect(session.listSessions()).toEqual([
      {
        id: "session-1",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        provider: "openai",
        model: "model",
        agentId: undefined,
        messageCount: 2,
        title: "hello world",
      },
    ]);
  });

  it("resolves a session by list index", () => {
    const session = makeSession([record("session-1"), record("session-2")]);

    expect(session.resolveSession("2")).toBe("session-2");
  });

  it("resolves a session by unique id prefix", () => {
    const session = makeSession([record("session-aaa"), record("session-bbb")]);

    expect(session.resolveSession("session-b")).toBe("session-bbb");
  });

  it("rejects ambiguous prefixes and unknown sessions", () => {
    const session = makeSession([record("session-aaa"), record("session-aab")]);

    expect(session.resolveSession("session-aa")).toBeUndefined();
    expect(session.resolveSession("missing")).toBeUndefined();
  });
});

describe("SessionManager agent loop", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    store = makeStore();
  });

  const makeSession = (overrides: Record<string, unknown> = {}) => {
    const session = new SessionManager(makeConfig({ autoCompact: false, ...overrides }), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    return session;
  };

  it("runs tool calls sequentially and feeds results back to the model", async () => {
    const session = makeSession();
    const execute = vi.fn(async () => ({ output: "tool output" }));

    session.tools.register({
      name: "echo",
      description: "Echo a value",
      parameters: { type: "object" },
      execute,
    });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [{ id: "call_1", name: "echo", args: { value: "hi" } }],
          finishReason: "toolCalls",
        },
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce(
        stopTurn("done", {
          promptTokens: 5,
          completionTokens: 2,
          totalTokens: 7,
        }),
      );

    const response = await session.ask("run echo");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.sessionId }),
      { value: "hi" },
    );
    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(response.text).toBe("done");
    expect(response.usage).toEqual({
      promptTokens: 15,
      completionTokens: 7,
      totalTokens: 22,
    });
    expect(session.history).toEqual([
      { role: "user", content: "run echo" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "echo", args: { value: "hi" } }],
      },
      { role: "tool", toolCallId: "call_1", content: "tool output" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("returns an error result when approval denies the command", async () => {
    const session = makeSession({ tools: { approval: "deny" } });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [
            {
              id: "call_1",
              name: "shell",
              args: { command: "rm -rf /" },
            },
          ],
          finishReason: "toolCalls",
        },
      })
      .mockResolvedValueOnce(stopTurn("blocked"));

    await session.ask("delete everything");

    expect(session.history).toContainEqual({
      role: "tool",
      toolCallId: "call_1",
      content: "[tool error] Command refused by policy: rm -rf /",
    });
  });

  it("emits one tool message per call, in order, padding unparsable calls", async () => {
    const session = makeSession();
    const execute = vi.fn(async () => ({ output: "ok" }));

    session.tools.register({
      name: "echo",
      description: "Echo a value",
      parameters: { type: "object" },
      execute,
    });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [
            { id: "call_1", name: "echo", args: { value: "hi" } },
            {
              id: "call_2",
              name: "echo",
              args: undefined,
              parseError: "Tool arguments are not valid JSON",
            },
          ],
          finishReason: "toolCalls",
        },
      })
      .mockResolvedValueOnce(stopTurn("done"));

    await session.ask("run two");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(session.history).toEqual([
      { role: "user", content: "run two" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "echo", args: { value: "hi" } },
          {
            id: "call_2",
            name: "echo",
            args: undefined,
            parseError: "Tool arguments are not valid JSON",
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "ok" },
      {
        role: "tool",
        toolCallId: "call_2",
        content: "[tool error] Tool arguments are not valid JSON",
      },
      { role: "assistant", content: "done" },
    ]);
  });

  it("stops after maxIterations when the model keeps calling tools", async () => {
    const session = makeSession({ tools: { maxIterations: 2 } });
    const execute = vi.fn(async () => ({ output: "again" }));

    session.tools.register({
      name: "loop",
      description: "Always callable",
      parameters: { type: "object" },
      execute,
    });

    provider.chat = vi.fn(async () => ({
      turn: {
        text: "",
        toolCalls: [{ id: "call_1", name: "loop", args: {} }],
        finishReason: "toolCalls" as const,
      },
    }));

    const response = await session.ask("spin");

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(response.text).toBe("Stopped: maximum tool iterations reached");
  });
});

describe("SessionManager turn outcome", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    store = makeStore();
  });

  const makeSession = () => {
    const session = new SessionManager(makeConfig({ autoCompact: false }), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    return session;
  };

  it("reports a completed turn with nothing pending", async () => {
    const session = makeSession();

    provider.chat = vi.fn().mockResolvedValueOnce(stopTurn("all good"));

    const response = await session.ask("go");

    expect(response.outcome).toEqual({ status: "completed", pending: [] });
  });

  it("reports the failing tools when a tool errors", async () => {
    const session = makeSession();
    session.tools.register({
      name: "broken",
      description: "Always fails",
      parameters: { type: "object" },
      execute: async () => ({ output: "boom", isError: true }),
    });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [{ id: "call_1", name: "broken", args: {} }],
          finishReason: "toolCalls",
        },
      })
      .mockResolvedValueOnce(
        stopTurn("recovered", { promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      );

    const response = await session.ask("go");

    expect(response.outcome).toEqual({
      status: "toolError",
      pending: ["broken"],
      next: "Review the failing tool output and retry.",
    });
  });

  it("retries an empty answer instead of closing the turn with it", async () => {
    const session = makeSession();

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce(stopTurn(""))
      .mockResolvedValueOnce(stopTurn("finally"));

    const response = await session.ask("go");

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(response.text).toBe("finally");
    // The empty attempt is not persisted: only "go" and the real answer remain.
    const assistant = session.history.filter((message) => message.role === "assistant");
    expect(assistant.map((message) => message.content)).toEqual(["finally"]);
  });

  it("fails the turn when the model stays empty, without persisting the empty message", async () => {
    const session = makeSession();

    provider.chat = vi.fn(async () => stopTurn(""));

    const response = await session.ask("go");

    // The loop retries the empty answer up to maxIterations (8 by default).
    expect(provider.chat.mock.calls.length).toBeGreaterThan(1);
    expect(response.text).toContain("empty response");
    expect(response.outcome?.status).toBe("incomplete");
    expect(response.outcome?.pending).toContain("get a non-empty answer from the model");
    // No assistant message with empty content reached the history.
    expect(session.history.some((message) => message.role === "assistant")).toBe(false);
  });

  it("reports an incomplete turn when the iteration cap is reached", async () => {
    const session = makeSession();

    // The model keeps asking for a tool the registry does not know, so the loop
    // never reaches an answer and hits maxIterations.
    provider.chat = vi.fn().mockResolvedValue({
      turn: {
        text: "",
        toolCalls: [{ id: "call_1", name: "missing", args: {} }],
        finishReason: "toolCalls",
      },
    });

    const response = await session.ask("go");

    expect(response.outcome?.status).toBe("incomplete");
    expect(response.outcome?.pending).toContain("finish the turn within tools.maxIterations");
    expect(response.outcome?.next).toContain("maxIterations");
  });
});

describe("SessionManager turn events", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    store = makeStore();
  });

  const makeSession = () => {
    const session = new SessionManager(makeConfig({ autoCompact: false }), store);
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    return session;
  };

  it("forwards tool output tagged with the originating call", async () => {
    const session = makeSession();
    session.tools.register({
      name: "stream",
      description: "Stream output",
      parameters: { type: "object" },
      execute: async (ctx) => {
        ctx.onOutput?.("live chunk");
        return { output: "final output" };
      },
    });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [{ id: "call_9", name: "stream", args: {} }],
          finishReason: "toolCalls",
        },
      })
      .mockResolvedValueOnce(stopTurn("done"));

    const events: ChatEvent[] = [];
    await session.ask("go", (event) => {
      events.push(event);
    });

    const outputs = events.filter((event) => event.type === "toolOutput");
    expect(outputs).toEqual([
      { type: "toolOutput", id: "call_9", name: "stream", chunk: "live chunk" },
    ]);
  });

  it("runs the turn unchanged when no listener is passed", async () => {
    const session = makeSession();
    session.tools.register({
      name: "stream",
      description: "Stream output",
      parameters: { type: "object" },
      execute: async (ctx) => {
        ctx.onOutput?.("ignored");
        return { output: "final output" };
      },
    });

    provider.chat = vi
      .fn()
      .mockResolvedValueOnce({
        turn: {
          text: "",
          toolCalls: [{ id: "call_9", name: "stream", args: {} }],
          finishReason: "toolCalls",
        },
      })
      .mockResolvedValueOnce(stopTurn("done"));

    const response = await session.ask("go");

    expect(response.text).toBe("done");
  });
});

describe("SessionManager spawn history", () => {
  let provider: OpenAiProvider;
  let store: SessionStore;
  let saved: Record<string, unknown>[];

  beforeEach(() => {
    provider = new OpenAiProvider("https://api.example.com", "key", "model");
    saved = [];
    store = {
      save: vi.fn((record: Record<string, unknown>) => saved.push(record)),
      load: vi.fn(() => null),
      list: vi.fn(() => []),
    } as unknown as SessionStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const makeSession = () => {
    const session = new SessionManager(
      makeConfig({
        autoCompact: false,
        defaultProvider: "openai",
        model: "model",
        providers: { openai: { url: "https://api.example.com", apikey: "key" } },
      }),
      store,
    );
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    return session;
  };

  const stubProvider = (text = "child answer") => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getModel").mockImplementation(function (
      this: OpenAiProvider,
    ) {
      return (this as unknown as { model?: string }).model ?? "model";
    });
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    vi.spyOn(OpenAiProvider.prototype, "chat").mockResolvedValue(stopTurn(text));
  };

  it("persists the launched child with its final status", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    const last = saved.at(-1);
    const spawns = last?.spawns as Array<Record<string, unknown>>;
    const stored = spawns.find((entry) => entry.spawnId === handle.spawnId);

    expect(stored).toMatchObject({ agentId: "coder", status: "done" });
    expect(stored?.finishedAt).toBeDefined();
  });

  it("stores a failed child with its error", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockRejectedValue(new Error("provider down"));
    const session = makeSession();

    const handle = session.spawn("coder", "boom");
    await session.waitSpawn(handle.spawnId);

    const spawns = saved.at(-1)?.spawns as Array<Record<string, unknown>>;
    const stored = spawns.find((entry) => entry.spawnId === handle.spawnId);

    expect(stored).toMatchObject({ status: "error" });
    expect(String(stored?.error)).toContain("provider down");
  });

  it("omits the field entirely when nothing was spawned", () => {
    const session = makeSession();
    session.save();

    expect(saved.at(-1)?.spawns).toBeUndefined();
  });
});

describe("SessionManager spawn", () => {
  const spawnConfig = {
    autoCompact: false,
    defaultProvider: "openai",
    model: "model",
    providers: { openai: { url: "https://api.example.com", apikey: "key" } },
  };

  // Stubs the provider the child builds through createProvider, avoiding any
  // real network call. Returns a spy so callers can assert on the chat prompt.
  const stubProvider = (text = "child answer") => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getModel").mockImplementation(function (
      this: OpenAiProvider,
    ) {
      return (this as unknown as { model?: string }).model ?? "model";
    });
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    const chat = vi.spyOn(OpenAiProvider.prototype, "chat").mockResolvedValue(stopTurn(text));
    return chat;
  };

// The store keeps no copy of what it is handed: the mock receives the very
// record the manager keeps mutating (history is the same array), so a
// snapshot taken after the fact reads a newer state. Cloning on every call is
// what "exactly as SessionStore would write it" means here: a JSON round trip
// plus the version the store stamps, because a record without it would be
// migrated as v1 on the next load.
const recordingStore = (saved: unknown[]) => {
const store = makeStore();
store.save = vi.fn((record: unknown) => {
saved.push(JSON.parse(JSON.stringify({ ...(record as object), version: 4 })));
}) as unknown as SessionStore["save"];
return store;
};

const makeSession = (overrides: Record<string, unknown> = {}, saved: unknown[] = []) => {
const session = new SessionManager(
makeConfig({ ...spawnConfig, ...overrides }),
recordingStore(saved),
);
    session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
    session.providerName = "openai";
    session.model = "model";
    return session;
  };

  // Child results reach the parent when it starts its next turn, so every
  // case that inspects the parent history has to run one. The parent answers
  // on its own stub: the child provider stub is not always installed (a child
  // that fails during initialize never reaches chat).
  const parentTurn = async (session: ReturnType<typeof makeSession>, prompt = "next turn") => {
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    session.provider!.chat = vi.fn(async () => stopTurn("parent ok"));
    await session.ask(prompt);
  };

  // The parent system messages that carry a child result.
  const deliveredFor = (session: ReturnType<typeof makeSession>, spawnId: string): string[] =>
    session.history
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .filter((content) => content.includes(`[spawn ${spawnId} `));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("spawns an isolated child session and collects its result", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing", {
      context: "parent context",
    });

    expect(handle).toMatchObject({ agentId: "coder", status: "running" });

    const settled = await session.waitSpawn(handle.spawnId);

    expect(settled).toMatchObject({ status: "done", result: "child answer" });
    expect(session.listSpawns()).toHaveLength(1);
    expect(session.pollSpawn(handle.spawnId)?.status).toBe("done");
  });

  it("prepends the delegated context to the child prompt", async () => {
    const chat = stubProvider("ok");
    const session = makeSession();

    const handle = session.spawn("coder", "the task", { context: "shared ctx" });
    await session.waitSpawn(handle.spawnId);

    const history = chat.mock.calls.at(-1)?.[0] ?? [];
    expect(history).toContainEqual({
      role: "user",
      content: "shared ctx\n\nthe task",
    });
  });

  it("injects the truncated child result into the parent history", async () => {
    stubProvider("child answer");
    const session = makeSession({ sessions: { childResultMaxChars: 5 } });

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await parentTurn(session);

    const [injected] = deliveredFor(session, handle.spawnId);
    expect(injected).toContain("child");
    expect(injected).toContain("…");
  });

  it("injects a system message with error status when the child fails", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockRejectedValue(new Error("provider down"));
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await parentTurn(session);

    expect(deliveredFor(session, handle.spawnId)).toContainEqual(
      expect.stringContaining(`[spawn ${handle.spawnId} · coder · error]`),
    );
  });

  // The final message of a child is the answer to the parent: it is the only
  // thing that crosses the session boundary. These cases pin the contract so
  // it cannot regress into a blank system message.
  it("injects the child text as the answer to the parent", async () => {
    stubProvider("the child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await parentTurn(session);

    expect(deliveredFor(session, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nthe child answer`,
    ]);
  });

  it("marks a child that answered nothing instead of injecting a blank line", async () => {
    stubProvider("");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await parentTurn(session);

    // A child with an empty answer is now a failed turn, not a "done" with no
    // output: the parent is told the child returned nothing to report.
    expect(deliveredFor(session, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nStopped: the model returned an empty response`,
    ]);
  });

  // The formatting is inspected directly for the error paths: launching a
  // child that fails would need a live provider, and the contract is the text
  // injected into the parent, not how the child died.
  const handleWith = (overrides: Partial<SpawnHandle> = {}): SpawnHandle => ({
    spawnId: "spawn-1",
    sessionId: "session-1",
    agentId: "coder",
    prompt: "do the thing",
    status: "done",
    startedAt: new Date(0).toISOString(),
    ...overrides,
  });

  const formatter = (session: ReturnType<typeof makeSession>) =>
    (
      session as unknown as {
        formatSpawnResult: (handle: SpawnHandle) => string;
      }
    ).formatSpawnResult.bind(session);

  it("marks a failed child with its error and no answer section", () => {
    const session = makeSession();

    expect(formatter(session)(handleWith({ status: "error", error: "provider down" }))).toBe(
      "[spawn spawn-1 · coder · error] provider down",
    );
  });

  it("falls back to unknown error when a failed child carries no message", () => {
    const session = makeSession();

    expect(formatter(session)(handleWith({ status: "error" }))).toBe(
      "[spawn spawn-1 · coder · error] unknown error",
    );
  });

  it("caps the child answer to the configured budget", () => {
    const session = makeSession({ sessions: { childResultMaxChars: 3 } });

    expect(formatter(session)(handleWith({ result: "abcdef" }))).toBe(
      "[spawn spawn-1 · coder · done]\nabc…",
    );
  });

  it("delivers spawn events to an external listener", async () => {
    stubProvider("child answer");
    const session = makeSession();
    const events: string[] = [];

    const unsubscribe = session.onSpawnEvent((event) => {
      events.push(`${event.type}:${event.handle.status}`);
    });

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    expect(events).toEqual(["started:running", "settled:done"]);
    unsubscribe();
  });

  it("stops delivering events after unsubscribe", async () => {
    stubProvider("child answer");
    const session = makeSession();
    const seen: string[] = [];

    const unsubscribe = session.onSpawnEvent((event) => {
      seen.push(event.type);
    });
    unsubscribe();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    expect(seen).toEqual([]);
  });

  it("keeps the parent system message when an external listener is present", async () => {
    stubProvider("child answer");
    const session = makeSession();

    // The external listener must be additive: it cannot replace the internal
    // subscription that injects the child result into the parent history.
    session.onSpawnEvent(() => {});

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await parentTurn(session);

    expect(deliveredFor(session, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
    ]);
  });

  it("survives a throwing listener without breaking the child", async () => {
    stubProvider("child answer");
    const session = makeSession();

    session.onSpawnEvent(() => {
      throw new Error("bad consumer");
    });

    const handle = session.spawn("coder", "do the thing");
    const settled = await session.waitSpawn(handle.spawnId);

    expect(settled).toMatchObject({ status: "done" });
  });

  it("rejects spawning when disabled by config", () => {
    const session = makeSession({ sessions: { spawnEnabled: false } });

    expect(() => session.spawn("coder", "x")).toThrow(/disabled/);
  });

  it("pins the shape the UI reads off every child", async () => {
    stubProvider("child answer");
    const session = makeSession();

    session.spawn("coder", "do the thing", { context: "ctx" });
    const [child] = session.listSpawns();

    // The progress strip needs the identity, the status and the two
    // timestamps; anything less and it cannot render a row.
    expect(child).toEqual({
      spawnId: expect.stringMatching(/^spawn-/),
      sessionId: session.sessionId,
      agentId: "coder",
      prompt: "do the thing",
      status: "running",
      startedAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(child!.startedAt))).toBe(false);
    // Both derived fields arrive with the settlement, never before it.
    expect(child!.summary).toBeUndefined();
    expect(child!.durationMs).toBeUndefined();
  });

  it("measures the duration and summarizes the answer once the child settles", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    const [child] = session.listSpawns();

    // Recomputed here from the two stamps, not read back from durationMs.
    const expected = Date.parse(child.finishedAt!) - Date.parse(child.startedAt);

    expect(child.status).toBe("done");
    expect(typeof child.durationMs).toBe("number");
    expect(child.durationMs).toBe(expected);
    expect(child.durationMs).toBeGreaterThanOrEqual(0);
    expect(child.durationMs).toBeLessThan(60_000);
    expect(child.summary).toBe("child answer");
  });

  it("measures the duration of a child that failed", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockRejectedValue(new Error("provider down"));
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    const [child] = session.listSpawns();

    const expected = Date.parse(child.finishedAt!) - Date.parse(child.startedAt);

    expect(child.status).toBe("error");
    expect(typeof child.durationMs).toBe("number");
    expect(child.durationMs).toBe(expected);
    expect(child.summary).toBe("provider down");
  });

  it("adds the result and the finish time once the child settles", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    expect(session.listSpawns()[0]).toMatchObject({
      status: "done",
      result: "child answer",
      finishedAt: expect.any(String),
    });
  });

  it("restores the summary and duration of a settled child on resume", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    // Same JSON round trip SessionStore performs on disk.
    const saved = vi.mocked(session.store.save).mock.calls.at(-1)?.[0];
    const persisted = JSON.parse(JSON.stringify(saved));
    const resumed = makeSession();
    resumed.store.load = vi.fn(() => persisted) as unknown as typeof resumed.store.load;

    await expect(resumed.load("session-1")).resolves.toBe(true);

    const [child] = resumed.childHistory();
    const expected = Date.parse(child.finishedAt!) - Date.parse(child.startedAt);

    expect(child.spawnId).toBe(handle.spawnId);
    expect(child.summary).toBe("child answer");
    expect(child.durationMs).toBe(expected);
    expect(typeof child.durationMs).toBe("number");
  });

  it("leaves the summary and duration undefined for a record written before them", async () => {
    stubProvider();
    const session = makeSession();
    const legacy = handleWith({
      spawnId: "spawn-legacy",
      status: "done",
      finishedAt: new Date(1_000).toISOString(),
      result: "done before the fields existed",
    });

    session.store.load = vi.fn(() => ({
      id: "session-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      provider: "openai",
      model: "model",
      agentId: "default",
      history: [],
      spawns: [legacy],
    })) as unknown as typeof session.store.load;

    await expect(session.load("session-1")).resolves.toBe(true);

    // Absent, not NaN nor an empty string.
    expect(session.childHistory()[0].summary).toBeUndefined();
    expect(session.childHistory()[0].durationMs).toBeUndefined();
  });

  it("keeps the children of a resumed session as read-only history", async () => {
    stubProvider();
    const session = makeSession();
    const persisted = [
      handleWith({
        spawnId: "spawn-old",
        status: "done",
        finishedAt: new Date(1_000).toISOString(),
        result: "done before the restart",
      }),
      handleWith({
        spawnId: "spawn-older",
        status: "error",
        startedAt: new Date(-1_000).toISOString(),
        finishedAt: new Date(0).toISOString(),
        error: "provider down",
      }),
    ];

    session.store.load = vi.fn(() => ({
      id: "session-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      provider: "openai",
      model: "model",
      agentId: "default",
      history: [],
      spawns: persisted,
    })) as unknown as typeof session.store.load;

    await expect(session.load("session-1")).resolves.toBe(true);

    // The persisted transcript survives (launch order, final status) but the
    // live view stays empty: those children cannot be polled or cancelled.
    expect(session.childHistory()).toEqual(persisted);
    expect(session.listSpawns()).toEqual([]);
    expect(session.pollSpawn("spawn-old")).toBeUndefined();
  });

  it("hands out a copy of the child history, not its own array", async () => {
    stubProvider("child answer");
    const session = makeSession();

    session.spawn("coder", "do the thing");
    session.childHistory().pop();

    expect(session.childHistory()).toHaveLength(1);
  });

  // The CLI needs to know whether a delegate already came back before it
  // starts reason about the parent conversation, so the list of children whose
  // result has not reached a parent turn is part of the contract.
  it("reports a settled child until the parent runs the turn that delivers it", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    const pending = session.pendingSpawns();
    expect(pending.map((entry) => entry.spawnId)).toEqual([handle.spawnId]);
    expect(session.history.filter((message) => message.role === "system")).toEqual([]);

    await parentTurn(session);

    expect(session.pendingSpawns()).toEqual([]);
    const injected = session.history.filter(
      (message) =>
        message.role === "system" && message.content.includes(`[spawn ${handle.spawnId} `),
    );
    expect(injected).toEqual([
      {
        role: "system",
        content: `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
      },
    ]);
  });

  // A turn that throws after the flush (provider error, abort, tool exception)
  // never reaches the save at the end of ask(), so delivery has to persist by
  // itself or a restart would drop the child result already marked as read.
  it("persists the delivered child result even when the turn then fails", async () => {
    stubProvider("child answer");
    const records: Array<Record<string, unknown>> = [];
    const storeWithHistory = {
      save: vi.fn((record: Record<string, unknown>) =>
        records.push(JSON.parse(JSON.stringify(record))),
      ),
      load: vi.fn(() => null),
      list: vi.fn(() => []),
    } as unknown as SessionStore;
    const session = new SessionManager(
      makeConfig({ ...spawnConfig, autoCompact: false }),
      storeWithHistory,
    );
    session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    expect(session.pendingSpawns().map((entry) => entry.spawnId)).toEqual([handle.spawnId]);

    session.provider.chat = vi.fn(async () => {
      throw new Error("provider down");
    });
    await expect(session.ask("what did the child say?")).rejects.toThrow("provider down");

    // Read back from the persisted record, not the in-memory history.
    expect(session.pendingSpawns()).toEqual([]);
    const persisted = records.at(-1);
    const stored = (persisted?.history as Array<{ role: string; content: string }>).filter(
      (message) =>
        message.role === "system" && message.content.includes(`[spawn ${handle.spawnId} `),
    );
    expect(stored).toEqual([
      {
        role: "system",
        content: `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
      },
    ]);
  });

  it("delivers two settled children in settlement order", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    vi.spyOn(OpenAiProvider.prototype, "chat").mockImplementation(async (history) => {
      const prompt = history.at(-1)?.content ?? "";
      // The slow child settles after the fast one, so launch order and
      // settlement order differ and cannot pass by accident.
      if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 20));
      return stopTurn(prompt.includes("slow") ? "slow answer" : "fast answer");
    });
    const session = makeSession();

    const slow = session.spawn("coder", "slow task");
    const fast = session.spawn("coder", "fast task");
    await session.waitSpawn(fast.spawnId);
    await session.waitSpawn(slow.spawnId);

    expect(session.pendingSpawns().map((entry) => entry.result)).toEqual([
      "fast answer",
      "slow answer",
    ]);

    await parentTurn(session);

    expect(
      session.history
        .filter((message) => message.role === "system")
        .map((message) => message.content.match(/^\[spawn [^ ]+/)?.[0]),
    ).toEqual([`[spawn ${fast.spawnId}`, `[spawn ${slow.spawnId}`]);
    expect(session.pendingSpawns()).toEqual([]);
  });

  it("does not report a running child as pending", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    // Never resolves: the child stays running for the whole case.
    vi.spyOn(OpenAiProvider.prototype, "chat").mockImplementation(() => new Promise(() => {}));
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");

    expect(session.pollSpawn(handle.spawnId)?.status).toBe("running");
    expect(session.pendingSpawns()).toEqual([]);
  });

  it("hands out a copy of the pending children, not its own array", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    session.pendingSpawns().length = 0;

    expect(session.pendingSpawns().map((entry) => entry.spawnId)).toEqual([handle.spawnId]);
  });

  // A settle without a parent turn leaves the result queued and the session
  // persisted. /resume used to drop that queue, losing the child in silence
  // while childHistory still listed it.
  it("queues a settled child that was never delivered when the session is resumed", async () => {
    stubProvider("child answer");
 const saved: unknown[] = [];
 const session = makeSession({}, saved);

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
 const persisted = saved.at(-1) as Record<string, unknown>;

 const resumed = makeSession({}, saved);
    resumed.store.load = vi.fn(() => persisted) as unknown as typeof resumed.store.load;
    await expect(resumed.load("session-1")).resolves.toBe(true);

    expect(resumed.pendingSpawns().map((entry) => entry.spawnId)).toEqual([handle.spawnId]);

    await parentTurn(resumed, "what did the child say?");

    expect(deliveredFor(resumed, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
    ]);
    expect(resumed.pendingSpawns()).toEqual([]);

    // Persist and resume once more: the result delivered above must not be
    // handed to the parent a second time.
 const resaved = saved.at(-1) as Record<string, unknown>;
    const third = makeSession();
    third.store.load = vi.fn(() => resaved) as unknown as typeof third.store.load;
    await expect(third.load("session-1")).resolves.toBe(true);

    expect(third.pendingSpawns()).toEqual([]);
    expect(deliveredFor(third, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
    ]);
  });

  it("does not queue a child already delivered before the resume", async () => {
    // A transport that answers both the child and the parent: the parent turn
    // is the one asking for "next turn".
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    vi.spyOn(OpenAiProvider.prototype, "chat").mockImplementation(async (history) =>
      history.some((message) => message.content === "next turn")
        ? stopTurn("parent ok")
        : stopTurn("child answer"),
    );
 const saved: unknown[] = [];
 const session = makeSession({}, saved);
 // A real session starts with its persona at history[0], and load() rewrites
 // that slot when the record carries an agentId: without it the child result,
 // which would be the first message, is the one overwritten instead.
 session["applySystemPrompt"]();
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);
    await session.ask("next turn");

 // The snapshot is taken when store.save is called (see recordingStore), so
 // it holds this record and not a later mutation of it.
 const persisted = saved.at(-1) as Record<string, unknown>;

    const resumed = makeSession();
    resumed.store.load = vi.fn(() => persisted) as unknown as typeof resumed.store.load;
    await expect(resumed.load("session-1")).resolves.toBe(true);

    expect(resumed.pendingSpawns()).toEqual([]);
    expect(deliveredFor(resumed, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
    ]);

    const restored = resumed.history.length;
    await parentTurn(resumed);

    expect(resumed.history.length).toBe(restored + 2);
    expect(deliveredFor(resumed, handle.spawnId)).toEqual([
      `[spawn ${handle.spawnId} · coder · done]\nchild answer`,
    ]);
  });

  it("does not queue a child that was still running when the process died", async () => {
    stubProvider();
    const session = makeSession();
    const running = handleWith({
      spawnId: "spawn-running",
      status: "running",
      startedAt: new Date(0).toISOString(),
    });

    session.store.load = vi.fn(() => ({
      id: "session-1",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      provider: "openai",
      model: "model",
      agentId: "default",
      history: [],
      spawns: [running],
    })) as unknown as typeof session.store.load;

    await expect(session.load("session-1")).resolves.toBe(true);

    expect(session.pendingSpawns()).toEqual([]);

    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    session.provider!.chat = vi.fn(async () => stopTurn("parent ok"));
    await session.ask("next turn");

    expect(deliveredFor(session, "spawn-running")).toEqual([]);
});

  it("delivers two settled children in settlement order", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    vi.spyOn(OpenAiProvider.prototype, "chat").mockImplementation(async (history) => {
      const prompt = history.at(-1)?.content ?? "";
      // The slow child settles after the fast one, so launch order and
      // settlement order differ and cannot pass by accident.
      if (prompt.includes("slow")) await new Promise((resolve) => setTimeout(resolve, 20));
      return stopTurn(prompt.includes("slow") ? "slow answer" : "fast answer");
    });
    const session = makeSession();

    const slow = session.spawn("coder", "slow task");
    const fast = session.spawn("coder", "fast task");
    await session.waitSpawn(fast.spawnId);
    await session.waitSpawn(slow.spawnId);

    expect(session.pendingSpawns().map((entry) => entry.result)).toEqual([
      "fast answer",
      "slow answer",
    ]);

    await parentTurn(session);

    expect(
      session.history
        .filter((message) => message.role === "system")
        .map((message) => message.content.match(/^\[spawn [^ ]+/)?.[0]),
    ).toEqual([`[spawn ${fast.spawnId}`, `[spawn ${slow.spawnId}`]);
    expect(session.pendingSpawns()).toEqual([]);
  });

  it("does not report a running child as pending", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockResolvedValue();
    vi.spyOn(OpenAiProvider.prototype, "setModel").mockReturnValue(true);
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    // Never resolves: the child stays running for the whole case.
    vi.spyOn(OpenAiProvider.prototype, "chat").mockImplementation(() => new Promise(() => {}));
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");

    expect(session.pollSpawn(handle.spawnId)?.status).toBe("running");
    expect(session.pendingSpawns()).toEqual([]);
  });

  it("hands out a copy of the pending children, not its own array", async () => {
    stubProvider("child answer");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    session.pendingSpawns().length = 0;

    expect(session.pendingSpawns().map((entry) => entry.spawnId)).toEqual([handle.spawnId]);
  });

  it("returns undefined/empty results when nothing was spawned", async () => {
    const session = makeSession();

    expect(session.pollSpawn("missing")).toBeUndefined();
    expect(session.listSpawns()).toEqual([]);
    await expect(session.waitSpawn("missing")).resolves.toBeUndefined();
    await expect(session.collectSpawns()).resolves.toEqual([]);
  });
});

// The UI repaints the transcript from core, so what counts as conversation
// has to be filtered here and not in each caller.
describe("SessionManager conversation", () => {
const makeSession = () => {
const session = new SessionManager(makeConfig({ autoCompact: false }), makeStore());
session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
session.providerName = "openai";
session.model = "model";
return session;
};

it("keeps user and assistant messages and drops system and tool ones", () => {
const session = makeSession();
session.history = [
{ role: "system", content: "you are a reviewer" },
{ role: "user", content: "first" },
{ role: "assistant", content: "answer one" },
{ role: "tool", content: "file contents", toolCallId: "call-1" },
{ role: "assistant", content: "answer two" },
];

expect(session.conversation()).toEqual([
{ role: "user", content: "first" },
{ role: "assistant", content: "answer one" },
{ role: "assistant", content: "answer two" },
]);
});

it("omits assistant turns that carry only tool calls", () => {
const session = makeSession();
session.history = [
{ role: "user", content: "do it" },
{ role: "assistant", content: "" },
{ role: "assistant", content: "   \n  " },
{ role: "assistant", content: "done" },
];

expect(session.conversation()).toEqual([
{ role: "user", content: "do it" },
{ role: "assistant", content: "done" },
]);
});

it("trims the content and drops entries left empty", () => {
const session = makeSession();
session.history = [
{ role: "user", content: "   " },
{ role: "user", content: "  real question  " },
];

expect(session.conversation()).toEqual([{ role: "user", content: "real question" }]);
});

it("returns an empty list for a record without history", () => {
const session = makeSession();

expect(session.conversation()).toEqual([]);
});

it("keeps the oldest message first", () => {
const session = makeSession();
session.history = [
{ role: "user", content: "one" },
{ role: "assistant", content: "two" },
{ role: "user", content: "three" },
{ role: "assistant", content: "four" },
];

expect(session.conversation().map((entry) => entry.content)).toEqual([
"one",
"two",
"three",
"four",
]);
});

it("hands out a copy, so mutating it never touches the history", () => {
const session = makeSession();
session.history = [{ role: "user", content: "keep me" }];

const conversation = session.conversation();
conversation.pop();
conversation.push({ role: "assistant", content: "invented" });

expect(session.history).toEqual([{ role: "user", content: "keep me" }]);
expect(session.conversation()).toEqual([{ role: "user", content: "keep me" }]);
});
});

// A turn the session started on its own (an automatic continuation after a
// child settled) is kept in the history for the model but hidden from the UI,
// and the same flag decides whether it can title the session.
describe("SessionManager unprompted turns", () => {
const makeSession = (withProvider = true) => {
const session = new SessionManager(makeConfig({ autoCompact: false }), makeStore());
if (withProvider) {
session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
session.providerName = "openai";
session.model = "model";
vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
}
return session;
};

it("keeps an unprompted turn in the history but leaves it out of conversation()", () => {
const session = makeSession(false);
session.history = [
{ role: "user", content: "fix the bug" },
{ role: "assistant", content: "fixing it" },
{ role: "user", content: "Continue with the work left by the children", unprompted: true },
{ role: "assistant", content: "nothing left to do" },
];

// The model still sees the turn: dropping it would change the context.
expect(session.history[2]).toEqual({
role: "user",
content: "Continue with the work left by the children",
unprompted: true,
});
expect(session.conversation()).toEqual([
{ role: "user", content: "fix the bug" },
{ role: "assistant", content: "fixing it" },
{ role: "assistant", content: "nothing left to do" },
]);
});

it("shows a regular turn that follows an unprompted one", () => {
const session = makeSession(false);
session.history = [
{ role: "user", content: "Continue with the work left by the children", unprompted: true },
{ role: "assistant", content: "nothing left to do" },
{ role: "user", content: "now write the report" },
];

expect(session.conversation()).toEqual([
{ role: "assistant", content: "nothing left to do" },
{ role: "user", content: "now write the report" },
]);
});

it("marks the turn ask() runs with unprompted in the history", async () => {
const session = makeSession();
session.provider!.chat = vi.fn(async () => stopTurn("answer"));

await session.ask("Continue with the work left by the children", undefined, {
unprompted: true,
});

expect(session.history).toEqual([
{
role: "user",
content: "Continue with the work left by the children",
unprompted: true,
},
{ role: "assistant", content: "answer" },
]);
expect(session.conversation()).toEqual([{ role: "assistant", content: "answer" }]);
});

it("stores a regular ask() turn without the flag", async () => {
const session = makeSession();
session.provider!.chat = vi.fn(async () => stopTurn("answer"));

await session.ask("what changed?");

expect(session.history[0]).toEqual({ role: "user", content: "what changed?" });
expect(session.conversation()).toEqual([
{ role: "user", content: "what changed?" },
{ role: "assistant", content: "answer" },
]);
});

it("keeps the prompt of an image turn in the history and in conversation()", async () => {
const session = makeSession();
vi.spyOn(session, "classifyAction").mockResolvedValue("imageGeneration");
session.provider!.generateImage = vi.fn(async () => ({
text: "image ready",
images: [{ url: "https://example.com/image.png" }],
}));

await session.ask("draw a cat");

expect(session.history).toEqual([{ role: "user", content: "draw a cat" }]);
expect(session.conversation()).toEqual([{ role: "user", content: "draw a cat" }]);
});

it("titles the session after the first real user turn, not the continuation", () => {
const store = makeStore();
store.list = vi.fn(() => [
{
id: "session-1",
createdAt: "2024-01-01T00:00:00.000Z",
updatedAt: "2024-01-02T00:00:00.000Z",
provider: "openai",
model: "model",
history: [
{
role: "user" as const,
content: "Continue with the work left by the children",
unprompted: true as const,
},
{ role: "assistant" as const, content: "nothing left to do" },
{ role: "user" as const, content: "real question" },
],
},
]) as unknown as SessionStore["list"];
const session = new SessionManager(makeConfig(), store);
session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
session.providerName = "openai";
session.model = "model";

expect(session.listSessions()[0].title).toBe("real question");
});
});
