import { beforeEach, describe, expect, it } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai";
const url = "https://api.cheaperinference.com/v1";
const apiKey = "ci_live_ac055aa75d5cd555c04765d5ab3235ccd50a75eb0396958a";

describe("OpenApi provider", () => {
  let provider: OpenAiProvider;

  beforeEach(() => {
    provider = new OpenAiProvider(url, apiKey, "gemini-3.7-flash");
  });

  it("getAvailableModels", async () => {
    const models = await provider.getAvailableModels();

    expect(models.length);
  });
});
