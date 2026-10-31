import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/configuration";
import { OpenAiProvider } from "../../src/providers/openai";
import { SessionManager } from "../../src/session/SessionManager";
import type { SessionStore } from "../../src/session/SessionStore";

const makeConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    config: { providers: {}, ...overrides },
  }) as unknown as Config;

const makeStore = () =>
  ({
    save: vi.fn(),
    load: vi.fn(() => null),
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
    provider.history = [{ role: "user", content: "hello" }];
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
    provider.history = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
    ];
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    provider.chat = vi.fn(async () => stopTurn());

    await session.ask("hello");

    expect(provider.history).toEqual([
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
    provider.history = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
    ];
    session.provider = provider;
    session.providerName = "openai";
    session.model = "model";
    vi.spyOn(session, "classifyAction").mockResolvedValue("textGeneration");
    provider.chat = vi.fn(async () => stopTurn());

    await session.ask("hello");

    expect(provider.history).toHaveLength(6);
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
    expect(provider.history).toEqual([
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

    expect(provider.history).toContainEqual({
      role: "tool",
      toolCallId: "call_1",
      content: "Command rejected by the user",
    });
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
