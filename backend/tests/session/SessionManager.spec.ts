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
    provider.ask = vi.fn(async () => ({
      text: "ok",
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      costUsd: 0.25,
    }));

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
    provider.ask = vi.fn(async () => ({ text: "ok" }));

    await session.ask("hello");

    expect(provider.history).toEqual([
      { role: "system", content: "[Memoria previa compactada]: user: u1 | user: u2 | user: u3 | user: u4" },
      { role: "user", content: "u5" },
      { role: "user", content: "u6" },
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
    provider.ask = vi.fn(async () => ({ text: "ok" }));

    await session.ask("hello");

    expect(provider.history).toHaveLength(4);
  });
});
