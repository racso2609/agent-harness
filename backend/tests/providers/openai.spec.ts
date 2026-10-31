import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai";
import type { Model } from "../../src/types/providers";

const url = "https://api.example.com/v1";
const apiKey = "test-api-key";
const DEFAULT_MODEL = "gemini-3.7-flash";

type FetchMock = ReturnType<typeof vi.fn>;

const capabilities = {
  vision: false,
  video: false,
  reasoning: false,
  streaming: true,
  image_generation: false,
  image_edit: false,
};

const modelsPayload = (
  models: Array<{ id: string; [key: string]: unknown }>,
) => ({
  object: "list",
  data: models.map((model) => ({ capabilities, ...model })),
});

const mockResponse = (payload: unknown) =>
  ({ ok: true, json: async () => payload }) as Response;

const mockFetchOnce = (fetchMock: FetchMock, payload: unknown) => {
  fetchMock.mockResolvedValueOnce(mockResponse(payload));
};

const streamResponse = (chunks: string[]) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  return { ok: true, body } as Response;
};

const mockStreamOnce = (fetchMock: FetchMock, chunks: string[]) => {
  fetchMock.mockResolvedValueOnce(streamResponse(chunks));
};

const expectedModel = (id: string, extra: Record<string, unknown> = {}) => ({
  name: id,
  id,
  capabilities,
  ...extra,
});

const loadModels = async (
  provider: OpenAiProvider,
  fetchMock: FetchMock,
  models: Array<{ id: string; [key: string]: unknown }> = [
    { id: DEFAULT_MODEL },
    { id: "another-model" },
  ],
) => {
  mockFetchOnce(fetchMock, modelsPayload(models));
  return provider.getAvailableModels();
};

describe("OpenAiProvider", () => {
  let provider: OpenAiProvider;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    provider = new OpenAiProvider(url, apiKey, DEFAULT_MODEL);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("stores the default model", () => {
      expect(provider.getModel()).toBe(DEFAULT_MODEL);
    });

    it("starts with an empty model list", () => {
      expect(() => provider.listModels()).toThrow(
        "Please initialize model list first",
      );
    });
  });

  describe("getAvailableModels", () => {
    it("requests the /models endpoint with the api key", async () => {
      await loadModels(provider, fetchMock);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`${url}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });
    });

    it("maps the response data to Model objects", async () => {
      const models = await loadModels(provider, fetchMock);

      expect(models).toEqual([
        expectedModel(DEFAULT_MODEL),
        expectedModel("another-model"),
      ]);
    });

    it("caches the fetched models", async () => {
      const models = await loadModels(provider, fetchMock);

      expect(provider.listModels()).toBe(models);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("maps context and pricing metadata returned by the API", async () => {
      mockFetchOnce(fetchMock, modelsPayload([
        {
          id: DEFAULT_MODEL,
          context_length: 128000,
          max_output_tokens: 4096,
          pricing: {
            input_per_million: "0.10",
            output_per_million: "0.40",
            currency: "USD",
          },
        },
      ]));

      const models = await provider.getAvailableModels();

      expect(models).toEqual([
        expectedModel(DEFAULT_MODEL, {
          contextLength: 128000,
          maxOutputTokens: 4096,
          pricing: {
            inputPerMillion: 0.1,
            outputPerMillion: 0.4,
            currency: "USD",
          },
        }),
      ]);
    });

    it("returns an empty list when the API has no models", async () => {
      const models = await loadModels(provider, fetchMock, []);

      expect(models).toEqual([]);
      expect(() => provider.listModels()).toThrow(
        "Please initialize model list first",
      );
    });

    it("propagates network errors", async () => {
      fetchMock.mockRejectedValueOnce(new Error("network down"));

      await expect(provider.getAvailableModels()).rejects.toThrow(
        "network down",
      );
    });

    it("propagates JSON parsing errors", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => {
          throw new Error("invalid json");
        },
      } as unknown as Response);

      await expect(provider.getAvailableModels()).rejects.toThrow(
        "invalid json",
      );
    });
  });

  describe("chat transport", () => {
    it("throws when the model list is not initialized", async () => {
      await expect(
        provider.chat([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("Please initialize model list first");
    });

    it("throws when the default model is not available", async () => {
      await loadModels(provider, fetchMock, [{ id: "unknown-model" }]);

      await expect(
        provider.chat([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("Model not available for this provider");
    });

    it("returns the assistant turn without mutating any history", async () => {
      await loadModels(provider, fetchMock);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"content":"first "}}]}\n\n`,
        `data: {"choices":[{"delta":{"content":"implementation"}}]}\n\n`,
        `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n`,
        "data: [DONE]\n\n",
      ]);

      const result = await provider.chat([
        { role: "user", content: "hello" },
      ]);

      expect(result).toEqual({
        turn: {
          text: "first implementation",
          toolCalls: [],
          finishReason: "other",
        },
        usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
        costUsd: 0,
      });
    });

    it("requests token usage from the streaming endpoint", async () => {
      await loadModels(provider, fetchMock);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`,
        "data: [DONE]\n\n",
      ]);

      await provider.chat([{ role: "user", content: "hello" }]);

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    it("exposes prompt plus completion tokens as current context usage", async () => {
      await loadModels(provider, fetchMock, [
        { id: DEFAULT_MODEL, context_length: 1000 },
      ]);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":250,"completion_tokens":5,"total_tokens":255}}\n\n`,
        "data: [DONE]\n\n",
      ]);

      await provider.chat([{ role: "user", content: "hello" }]);

      expect(provider.getContextWindow()).toBe(1000);
      expect(provider.getContextTokens()).toBe(255);

      provider.resetContextUsage();
      expect(provider.getContextTokens()).toBe(0);
    });

    it("computes the request cost from the model pricing", async () => {
      await loadModels(provider, fetchMock, [
        {
          id: DEFAULT_MODEL,
          pricing: {
            input_per_million: "2",
            output_per_million: "8",
            currency: "USD",
          },
        },
      ]);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1000000,"completion_tokens":500000,"total_tokens":1500000}}\n\n`,
        "data: [DONE]\n\n",
      ]);

      const result = await provider.chat([
        { role: "user", content: "hello" },
      ]);

      expect(result.costUsd).toBeCloseTo(6);
    });
  });

  describe("setModel", () => {
    it("throws when the model list is not initialized", () => {
      expect(() => provider.setModel(DEFAULT_MODEL)).toThrow(
        "Please initialize model list first",
      );
    });

    it("throws when the model does not exist", async () => {
      await loadModels(provider, fetchMock);

      expect(() => provider.setModel("missing-model")).toThrow(
        "Model not available for this provider",
      );
    });

    it("sets the model by id and returns true", async () => {
      await loadModels(provider, fetchMock);

      expect(provider.setModel("another-model")).toBe(true);
      expect(provider.getModel()).toBe("another-model");
    });

    it("sets the model by name alias", async () => {
      mockFetchOnce(
        fetchMock,
        modelsPayload([{ id: "canonical-id" }]),
      );
      await provider.getAvailableModels();
      provider.setModel("canonical-id");

      expect(provider.getModel()).toBe("canonical-id");
    });

    it("keeps the previous model when the update fails", async () => {
      await loadModels(provider, fetchMock);

      expect(() => provider.setModel("missing-model")).toThrow();
      expect(provider.getModel()).toBe(DEFAULT_MODEL);
    });

    it("allows switching between available models", async () => {
      await loadModels(provider, fetchMock);

      provider.setModel("another-model");
      provider.setModel(DEFAULT_MODEL);

      expect(provider.getModel()).toBe(DEFAULT_MODEL);
    });
  });

  describe("listModels", () => {
    it("returns the cached models", async () => {
      const models = await loadModels(provider, fetchMock);

      expect(provider.listModels()).toBe(models);
    });

    it("does not fetch again after the models are loaded", async () => {
      await loadModels(provider, fetchMock);
      provider.listModels();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("chat", () => {
    it("accumulates streamed tool calls by index and maps them to camelCase", async () => {
      await loadModels(provider, fetchMock);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"readFile","arguments":""}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n`,
        `data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n`,
        `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n`,
        "data: [DONE]\n\n",
      ]);

      const result = await provider.chat(
        [{ role: "user", content: "read a.txt" }],
        {
          tools: [
            {
              name: "readFile",
              description: "Read a file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
              },
            },
          ],
        },
      );

      expect(result.turn).toEqual({
        text: "",
        finishReason: "toolCalls",
        toolCalls: [
          {
            id: "call_1",
            name: "readFile",
            args: { path: "a.txt" },
            rawArgs: '{"path":"a.txt"}',
          },
        ],
      });
      expect(result.usage).toEqual({
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
      });
    });

    it("sends tool specs and tool messages using the wire snake_case contract", async () => {
      await loadModels(provider, fetchMock);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`,
        "data: [DONE]\n\n",
      ]);

      const toolCall = {
        id: "call_1",
        name: "shell",
        args: { command: "ls" },
        rawArgs: '{"command":"ls"}',
      };

      await provider.chat(
        [
          { role: "user", content: "list" },
          { role: "assistant", content: "", toolCalls: [toolCall] },
          { role: "tool", toolCallId: "call_1", content: "a.txt" },
        ],
        {
          tools: [
            {
              name: "shell",
              description: "Run a command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          ],
        },
      );

      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(String(init.body));

      expect(body.tools).toEqual([
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ]);
      expect(body.messages[1].tool_calls).toEqual([
        {
          id: "call_1",
          type: "function",
          function: { name: "shell", arguments: '{"command":"ls"}' },
        },
      ]);
      expect(body.messages[2]).toMatchObject({
        role: "tool",
        tool_call_id: "call_1",
        content: "a.txt",
      });
    });

    it("flags malformed tool arguments instead of throwing", async () => {
      await loadModels(provider, fetchMock);
      mockStreamOnce(fetchMock, [
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{oops"}}]},"finish_reason":"tool_calls"}]}\n\n`,
        "data: [DONE]\n\n",
      ]);

      const result = await provider.chat([
        { role: "user", content: "run" },
      ]);

      expect(result.turn.toolCalls[0]).toMatchObject({
        id: "call_1",
        name: "shell",
        rawArgs: "{oops",
        parseError: "Tool arguments are not valid JSON",
      });
    });
  });

  describe("model aliasing", () => {
    it("matches models by name and by id", async () => {
      mockFetchOnce(
        fetchMock,
        modelsPayload([{ id: "id-only" }, { id: "alias-name" }]),
      );
      await provider.getAvailableModels();

      expect(provider.setModel("id-only")).toBe(true);
      expect(() => provider.setModel("alias-name")).not.toThrow();

      const models: Model[] = provider.listModels();
      expect(models.map((m) => m.id)).toEqual(["id-only", "alias-name"]);
    });
  });
});