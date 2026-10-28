import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai";
import type { History, Model } from "../../src/types/providers";

const url = "https://api.example.com/v1";
const apiKey = "test-api-key";
const DEFAULT_MODEL = "gemini-3.7-flash";

type FetchMock = ReturnType<typeof vi.fn>;

const modelsPayload = (models: Array<{ id: string }>) => ({
  object: "list",
  data: models,
});

const mockResponse = (payload: unknown) =>
  ({ ok: true, json: async () => payload }) as Response;

const mockFetchOnce = (fetchMock: FetchMock, payload: unknown) => {
  fetchMock.mockResolvedValueOnce(mockResponse(payload));
};

const loadModels = async (
  provider: OpenAiProvider,
  fetchMock: FetchMock,
  models: Array<{ id: string }> = [
    { id: DEFAULT_MODEL },
    { id: "another-model" },
  ],
) => {
  mockFetchOnce(fetchMock, modelsPayload(models));
  return provider.getAvailableModels();
};

const userMessages = (...contents: string[]): History[] =>
  contents.map((content) => ({ role: "user" as const, content }));

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

    it("starts with an empty history", () => {
      expect(provider.history).toEqual([]);
    });

    it("starts with an empty model list", () => {
      expect(() => provider.listModels()).toThrow(
        "Please initialize model list first",
      );
    });

    it("uses a compact threshold of 4 by default", () => {
      expect(provider.compactThreshold).toBe(4);
    });
  });

  describe("getAvailableModels", () => {
    it("requests the /models endpoint with the api key", async () => {
      await loadModels(provider, fetchMock);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(`${url}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    });

    it("maps the response data to Model objects", async () => {
      const models = await loadModels(provider, fetchMock);

      expect(models).toEqual([
        { name: DEFAULT_MODEL, id: DEFAULT_MODEL },
        { name: "another-model", id: "another-model" },
      ]);
    });

    it("caches the fetched models", async () => {
      const models = await loadModels(provider, fetchMock);

      expect(provider.listModels()).toBe(models);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("ignores extra fields returned by the API", async () => {
      mockFetchOnce(fetchMock, {
        data: [
          {
            id: DEFAULT_MODEL,
            context_length: 128000,
            pricing: { input_per_million: "0.10" },
          },
        ],
      });

      const models = await provider.getAvailableModels();

      expect(models).toEqual([{ name: DEFAULT_MODEL, id: DEFAULT_MODEL }]);
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
      } as Response);

      await expect(provider.getAvailableModels()).rejects.toThrow(
        "invalid json",
      );
    });
  });

  describe("ask", () => {
    it("throws when input is empty", async () => {
      await expect(provider.ask("")).rejects.toThrow(
        "Please type what do you want to ask to the agent",
      );
    });

    it("throws when the model list is not initialized", async () => {
      await expect(provider.ask("hello")).rejects.toThrow(
        "Please initialize model list first",
      );
    });

    it("throws when the default model is not available", async () => {
      await loadModels(provider, fetchMock, [{ id: "unknown-model" }]);

      await expect(provider.ask("hello")).rejects.toThrow(
        "Model not available for this provider",
      );
    });

    

    it("appends the user input and the response to the history", async () => {
      await loadModels(provider, fetchMock);

      const response = await provider.ask("hello");

      expect(response).toEqual({ text: "first implementation" });
      expect(provider.history).toEqual([
        { role: "user", content: "hello" },
        { role: "system", content: "first implementation" },
      ]);
    });

    it("does not modify the history when validation fails", async () => {
      await expect(provider.ask("")).rejects.toThrow();
      expect(provider.history).toEqual([]);
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

  describe("compact", () => {
    it("returns the same history when there are no messages", () => {
      const history: History[] = [];
      provider.history = history;

      expect(provider.compact()).toBe(history);
    });

    it("returns the same history when user messages equal the threshold", () => {
      const history = userMessages("u1", "u2", "u3", "u4");
      provider.history = history;

      expect(provider.compact()).toBe(history);
      expect(provider.history).toEqual(history);
    });

    it("returns the same history when user messages are below the threshold", () => {
      const history = userMessages("u1", "u2");
      provider.history = history;

      expect(provider.compact()).toBe(history);
    });

    it("summarizes older messages and keeps the most recent ones", () => {
      provider.history = userMessages("u1", "u2", "u3", "u4", "u5", "u6");

      const compacted = provider.compact();

      expect(compacted).toEqual([
        { role: "system", content: "[Memoria previa compactada]: user: u1 | user: u2" },
        { role: "user", content: "u3" },
        { role: "user", content: "u4" },
        { role: "user", content: "u5" },
        { role: "user", content: "u6" },
      ]);
    });

    it("uses a custom threshold", () => {
      provider.history = userMessages("u1", "u2", "u3");

      const compacted = provider.compact(2);

      expect(compacted).toEqual([
        { role: "system", content: "[Memoria previa compactada]: user: u1" },
        { role: "user", content: "u2" },
        { role: "user", content: "u3" },
      ]);
    });

    it("preserves system messages before the compacted memory", () => {
      provider.history = [
        { role: "system", content: "you are a helpful agent" },
        ...userMessages("u1", "u2", "u3", "u4", "u5", "u6"),
      ];

      const compacted = provider.compact();

      expect(compacted).toEqual([
        { role: "system", content: "you are a helpful agent" },
        { role: "system", content: "[Memoria previa compactada]: user: u1 | user: u2" },
        { role: "user", content: "u3" },
        { role: "user", content: "u4" },
        { role: "user", content: "u5" },
        { role: "user", content: "u6" },
      ]);
    });

    it("preserves multiple system messages in order", () => {
      provider.history = [
        { role: "system", content: "first system" },
        { role: "system", content: "second system" },
        ...userMessages("u1", "u2", "u3", "u4", "u5"),
      ];

      const compacted = provider.compact();

      expect(compacted.slice(0, 2)).toEqual([
        { role: "system", content: "first system" },
        { role: "system", content: "second system" },
      ]);
      expect(compacted[2]).toEqual({
        role: "system",
        content: "[Memoria previa compactada]: user: u1",
      });
    });

    it("does not count system messages towards the threshold", () => {
      const history: History[] = [
        ...userMessages("u1", "u2", "u3", "u4"),
        { role: "system", content: "system after users" },
      ];
      provider.history = history;

      expect(provider.compact()).toBe(history);
    });

    it("updates the provider history with the compacted result", () => {
      provider.history = userMessages("u1", "u2", "u3", "u4", "u5", "u6");

      const compacted = provider.compact();

      expect(provider.history).toBe(compacted);
    });

    it("uses the default threshold when none is provided", () => {
      provider.history = userMessages("u1", "u2", "u3", "u4", "u5");

      const compacted = provider.compact();

      expect(compacted).toEqual([
        { role: "system", content: "[Memoria previa compactada]: user: u1" },
        ...userMessages("u2", "u3", "u4", "u5"),
      ]);
    });

    it("produces only valid History entries", () => {
      provider.history = [
        { role: "system", content: "system" },
        ...userMessages("u1", "u2", "u3", "u4", "u5", "u6"),
      ];

      const compacted = provider.compact();

      expect(Array.isArray(compacted)).toBe(true);
      for (const message of compacted) {
        expect(Array.isArray(message)).toBe(false);
        expect(["system", "user"]).toContain(message.role);
        expect(typeof message.content).toBe("string");
      }
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