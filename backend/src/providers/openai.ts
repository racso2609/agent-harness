import { History, Model, Provider } from "@/types/providers";
import { BasicProvider } from "./basic";
import { OpenAIModelsResponse } from "@/types/openai";

enum Errors {
  NO_LIST_INITIALIZATED = "Please initialize model list first",
  MODEL_NOT_FOUND = "Model not available for this provider",
  MISSING_INPUT = "Please type what do you want to ask to the agent",
}

export class OpenAiProvider extends BasicProvider implements Provider {
  protected models: Model[] = [];
  protected model = "";
  history: History[] = [];
  compactThreshold = 4;

  constructor(url: string, apikey: string, defaultModel: string) {
    super(url, apikey);
    this.model = defaultModel;
  }

  async getAvailableModels() {
    const models = await this._fetcher<OpenAIModelsResponse>("/models");
    const mappedModels = models.data.map((m) => {
      return {
        name: m.id,
        id: m.id,
      };
    });

    this.models = mappedModels;

    return mappedModels as Model[];
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

    return this.history;
  }

  async ask(input: string) {
    if (!input) throw new Error(Errors.MISSING_INPUT);
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const modelExist = this.finModel(this.model);

    if (!modelExist) throw new Error(Errors.MODEL_NOT_FOUND);

    this.history.push({ role: "user", content: input });

    const response = { text: "first implementation" };

    this.history.push({ role: "system", content: response.text });

    return response;
  }

  setModel(model: string) {
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const modelExist = this.finModel(model);

    if (!modelExist) throw new Error(Errors.MODEL_NOT_FOUND);

    this.model = modelExist.id;

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
