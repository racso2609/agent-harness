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
      stopTurn(
        "ok",
        { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        0.25,
      ),
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
    const session = new SessionManager(
      makeConfig({ autoCompact: false, ...overrides }),
      store,
    );
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
    session["createProvider"] = ((
      name: string,
      _config: unknown,
      model: string,
    ) => {
      created.push({ provider: name, model });
      const fake = new OpenAiProvider("https://api.example.com", "key", model);
      fake.initialize = vi.fn(async () => {});
      fake.setModel = vi.fn(() => true);
      fake.getModel = () => model;
      return fake;
    }) as unknown as typeof session["createProvider"];
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
    session["createProvider"] = ((
      name: string,
      _config: unknown,
      model: string,
    ) => {
      created.push({ provider: name, model });
      const fake = new OpenAiProvider("https://api.example.com", "key", model);
      fake.initialize = vi.fn(async () => {});
      fake.setModel = vi.fn(() => true);
      fake.getModel = () => model;
      return fake;
    }) as unknown as typeof session["createProvider"];
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
    const session = new SessionManager(
      makeConfig({ autoCompact: false, ...overrides }),
      store,
    );
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
          toolCalls: [
            { id: "call_1", name: "echo", args: { value: "hi" } },
          ],
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
expect(response.outcome?.pending).toContain(
"finish the turn within tools.maxIterations",
);
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
vi.spyOn(OpenAiProvider.prototype, "getModel").mockImplementation(
function (this: OpenAiProvider) {
return (this as unknown as { model?: string }).model ?? "model";
},
);
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
vi.spyOn(OpenAiProvider.prototype, "initialize").mockRejectedValue(
new Error("provider down"),
);
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
    vi.spyOn(OpenAiProvider.prototype, "getModel").mockImplementation(
      function (this: OpenAiProvider) {
        return (this as unknown as { model?: string }).model ?? "model";
      },
    );
    vi.spyOn(OpenAiProvider.prototype, "getContextWindow").mockReturnValue(1000);
    const chat = vi
      .spyOn(OpenAiProvider.prototype, "chat")
      .mockResolvedValue(stopTurn(text));
    return chat;
  };

  const makeSession = (overrides: Record<string, unknown> = {}) => {
    const session = new SessionManager(
      makeConfig({ ...spawnConfig, ...overrides }),
      makeStore(),
    );
    session.provider = new OpenAiProvider("https://api.example.com", "key", "model");
    session.providerName = "openai";
    session.model = "model";
    return session;
  };

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

    const injected = session.history.find(
      (message) =>
        message.role === "system" &&
        message.content.includes(`[spawn ${handle.spawnId}`),
    );
    expect(injected?.content).toContain("child");
    expect(injected?.content).toContain("…");
  });

  it("injects a system message with error status when the child fails", async () => {
    vi.spyOn(OpenAiProvider.prototype, "initialize").mockRejectedValue(
      new Error("provider down"),
    );
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    expect(session.history).toContainEqual(
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining(`[spawn ${handle.spawnId} · coder · error]`),
      }),
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

    expect(session.history).toContainEqual({
      role: "system",
      content: `[spawn ${handle.spawnId} · coder · done]\nthe child answer`,
    });
  });

  it("marks a child that answered nothing instead of injecting a blank line", async () => {
    stubProvider("");
    const session = makeSession();

    const handle = session.spawn("coder", "do the thing");
    await session.waitSpawn(handle.spawnId);

    expect(session.history).toContainEqual({
      role: "system",
      content: `[spawn ${handle.spawnId} · coder · done]\n(no output)`,
    });
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

    expect(
      formatter(session)(
        handleWith({ status: "error", error: "provider down" }),
      ),
    ).toBe("[spawn spawn-1 · coder · error] provider down");
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

const injected = session.history.find(
(message) =>
message.role === "system" &&
message.content.includes(`[spawn ${handle.spawnId}`),
);
expect(injected?.content).toContain("child answer");
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

  it("returns undefined/empty results when nothing was spawned", async () => {
    const session = makeSession();

    expect(session.pollSpawn("missing")).toBeUndefined();
    expect(session.listSpawns()).toEqual([]);
    await expect(session.waitSpawn("missing")).resolves.toBeUndefined();
    await expect(session.collectSpawns()).resolves.toEqual([]);
  });
});
