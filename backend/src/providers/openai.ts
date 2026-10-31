import { History, Model, Provider, TokenUsage } from "@/types/providers";
import { BasicProvider } from "./basic";
import {
  Datum,
  OpenAIChatUsage,
  OpenAIImageResponse,
  OpenAIModelsResponse,
} from "@/types/openai";
import { logger } from "@/utils/logger";

enum Errors {
  NO_LIST_INITIALIZATED = "Please initialize model list first",
  MODEL_NOT_FOUND = "Model not available for this provider",
  MISSING_INPUT = "Please type what do you want to ask to the agent",
  MISSING_CAPABILITIES = "Missing capabilities: ",
}

export class OpenAiProvider extends BasicProvider implements Provider {
  protected models: Model[] = [];
  protected model = "";
  history: History[] = [];
  compactThreshold = 4;
  protected contextWindow?: number;
  protected lastContextTokens = 0;
  protected _onChunk = async (_content: string, _done: boolean) => {};

  constructor(
    url: string,
    apikey: string,
    defaultModel: string,
    onChunk?: (content: string, done: boolean) => Promise<void>,
  ) {
    super(url, apikey);
    this.model = defaultModel;
    if (onChunk) this._onChunk = onChunk;
  }

  async initialize() {
    await this.getAvailableModels();
  }

  async getAvailableModels() {
    const models = await this._fetcher<OpenAIModelsResponse>(
      "/models",
      {},
      false,
    );
    const mappedModels = models.data.map((model) => this.mapModel(model));

    this.models = mappedModels;
    this.syncContextWindow();

    return mappedModels;
  }

  protected mapModel(model: Datum): Model {
    const mapped: Model = {
      name: model.id,
      id: model.id,
      capabilities: model.capabilities,
    };

    if (model.context_length != null) mapped.contextLength = model.context_length;
    if (model.max_output_tokens != null)
      mapped.maxOutputTokens = model.max_output_tokens;

    if (model.pricing) {
      mapped.pricing = {
        inputPerMillion: Number(model.pricing.input_per_million),
        outputPerMillion: Number(model.pricing.output_per_million),
        currency: model.pricing.currency,
      };
    }

    return mapped;
  }

  protected syncContextWindow() {
    this.contextWindow = this.finModel(this.model)?.contextLength;
  }

  compact(compactThreshold = this.compactThreshold) {
    const { systemMessages, nonSystemMessages } = this.history.reduce(
      (acc, data) => {
        if (!acc.systemMessages) acc.systemMessages = [];
        if (!acc.nonSystemMessages) acc.nonSystemMessages = [];

        if (data.role === "system") acc.systemMessages.push(data);
        if (data.role === "user") acc.nonSystemMessages.push(data);

        return acc;
      },
      { systemMessages: [] as History[], nonSystemMessages: [] as History[] },
    );

    if (nonSystemMessages?.length <= compactThreshold) return this.history;

    const recentMessages = nonSystemMessages.slice(-compactThreshold);
    const olderMessages = nonSystemMessages.slice(0, -compactThreshold);
    const summaryText = olderMessages
      .map((m) => `${m.role}: ${m.content}`)
      .join(" | ");

    const memoryBlock = {
      role: "system",
      content: `[Memoria previa compactada]: ${summaryText}`,
    };

    // Reconstruimos el contexto optimizado
    this.history = [...systemMessages, memoryBlock, ...recentMessages].filter(
      Boolean,
    ) as History[]; // Limpia nulos si no hay system prompt
    this.lastContextTokens = 0;

    return this.history;
  }

  protected async _handleStream(response: Response) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullAssistantResponse = "";
    let usage: TokenUsage | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]")
          continue;

        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.replace("data: ", ""));
            const content = json.choices?.[0]?.delta?.content;

            if (content) {
              fullAssistantResponse += content;
              if (this._onChunk) this._onChunk?.(content, done); // Notificas al exterior en tiempo real
            }

            if (json.usage) usage = this.mapUsage(json.usage);
          } catch (err) {
            // Ignorar errores de parseo en chunks parciales
          }
        }
      }
    }

    return { text: fullAssistantResponse, usage };
  }

  protected mapUsage(usage: OpenAIChatUsage): TokenUsage {
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;

    return {
      promptTokens,
      completionTokens,
      totalTokens: usage.total_tokens ?? promptTokens + completionTokens,
    };
  }

  async ask(input: string) {
    if (!input) throw new Error(Errors.MISSING_INPUT);
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const modelExist = this.finModel(this.model);

    if (!modelExist) throw new Error(Errors.MODEL_NOT_FOUND);
    if (!modelExist.capabilities.streaming)
      throw new Error(Errors.MISSING_CAPABILITIES + "streaming");

    this.history.push({ role: "user", content: input });

    const messages = this.history.map((m) => ({
      ...m,
      content: this.format(m.content),
    }));

    const response = (await this._fetcher(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: modelExist.id,
          messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      true,
    )) as Response;
    const { text, usage } = await this._handleStream(response);

    this.lastContextTokens = usage
      ? usage.promptTokens + usage.completionTokens
      : this.estimateHistoryTokens();
    this.history.push({ role: "system", content: text });

    return { text, usage, costUsd: usage ? this.costOf(usage) : undefined };
  }

  protected estimateHistoryTokens() {
    const characters = this.history.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    return Math.ceil(characters / 4);
  }

  protected costOf(usage: TokenUsage) {
    const pricing = this.finModel(this.model)?.pricing;
    if (!pricing) return 0;

    return (
      (usage.promptTokens / 1_000_000) * pricing.inputPerMillion +
      (usage.completionTokens / 1_000_000) * pricing.outputPerMillion
    );
  }

  getContextWindow() {
    return this.contextWindow;
  }

  getContextTokens() {
    return this.lastContextTokens || this.estimateHistoryTokens();
  }
  async generateImage(prompt: string) {
    if (!prompt) throw new Error(Errors.MISSING_INPUT);
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const modelExist = this.finModel(this.model);

    if (!modelExist) throw new Error(Errors.MODEL_NOT_FOUND);
    if (!modelExist.capabilities.image_generation)
      throw new Error(Errors.MISSING_CAPABILITIES + "image-generation");
    const response = await this._fetcher<OpenAIImageResponse>(
      "/images/generations",
      {
        method: "POST",
        body: JSON.stringify({
          model: modelExist.id,
          prompt: prompt,
          size: "1024x1024",
        }),
      },
      false,
    );
    logger.debug({ response }, "image generation response");

    const images = response.data.map((i) => {
      return {
        url: "url" in i ? i.url : i.b64_json,
      };
    });

    return { text: "Image generated", images };
  }

  setModel(model: string) {
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const modelExist = this.finModel(model);

    if (!modelExist) throw new Error(Errors.MODEL_NOT_FOUND);

    this.model = modelExist.id;
    this.syncContextWindow();

    return true;
  }

  getModel() {
    return this.model;
  }

  listModels() {
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    return this.models;
  }

  protected finModel(modelNameOrId: string) {
    const modelExist = this.models.find((m) => {
      return m.name === modelNameOrId || m.id === modelNameOrId;
    });

    return modelExist;
  }
}
