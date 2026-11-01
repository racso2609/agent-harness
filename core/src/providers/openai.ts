import type {
  AssistantTurn,
  ChatEventListener,
  ChatOptions,
  ChatResult,
  FinishReason,
  History,
  Model,
  Provider,
  TokenUsage,
  ToolCall,
  ToolSpec,
} from "@/types/providers";
import { BasicProvider } from "./basic";
import { normalizeToolMarkup } from "./normalizeToolMarkup";
import type {
  Datum,
  OpenAIChatMessage,
  OpenAIChatUsage,
  OpenAIImageResponse,
  OpenAIModelsResponse,
  OpenAIStreamChunk,
  OpenAIToolCallPayload,
  OpenAIToolSpec,
} from "@/types/openai";
import { logger } from "@/utils/logger";

const mapFinishReason = (reason?: string | null): FinishReason => {
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "toolCalls";
    case "length":
      return "length";
    case "content_filter":
      return "contentFilter";
    default:
      return "other";
  }
};

const parseArguments = (
  raw: string,
): { args: unknown; parseError?: string } => {
  if (!raw.trim()) return { args: {} };

  try {
    return { args: JSON.parse(raw) as unknown };
  } catch {
    return { args: undefined, parseError: "Tool arguments are not valid JSON" };
  }
};

// Accumulator for one streamed tool call, keyed by its delta index.
type PartialToolCall = { id: string; name: string; rawArgs: string };

enum Errors {
  NO_LIST_INITIALIZATED = "Please initialize model list first",
  MODEL_NOT_FOUND = "Model not available for this provider",
  MISSING_INPUT = "Please type what do you want to ask to the agent",
  MISSING_CAPABILITIES = "Missing capabilities: ",
}

export class OpenAiProvider extends BasicProvider implements Provider {
  protected models: Model[] = [];
  protected model = "";
  protected contextWindow?: number;
  protected lastContextTokens = 0;
  // When true, tool calls emitted as text markup are normalized (see
  // normalizeToolMarkup). Enabled by default; toggled via config.
  normalizeTextToolCalls = true;
  protected _onChunk: (content: string, done: boolean) => Promise<void> =
    async () => {};

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

  protected async _handleStream(
    response: Response,
    onEvent?: ChatEventListener,
  ): Promise<{ turn: AssistantTurn; usage?: TokenUsage }> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullAssistantResponse = "";
    let fullReasoning = "";
    let usage: TokenUsage | undefined;
    let finishReason: string | null = null;
    const partialCalls = new Map<number, PartialToolCall>();

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
            const json = JSON.parse(
              trimmed.replace("data: ", ""),
            ) as OpenAIStreamChunk;
            const choice = json.choices?.[0];
            const content = choice?.delta?.content;

            if (content) {
              fullAssistantResponse += content;
              if (this._onChunk) this._onChunk?.(content, done); // Notificas al exterior en tiempo real
    onEvent?.({ type: "text", delta: content });

            }

    // Reasoning is streamed by DeepSeek-style gateways and stays out of the
    // answer text; it is emitted live and kept on the turn for the UI.
    const reasoningDelta =
    choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (reasoningDelta) {
    fullReasoning += reasoningDelta;
    onEvent?.({ type: "reasoning", delta: reasoningDelta });
    }

            if (choice?.finish_reason) finishReason = choice.finish_reason;

            for (const delta of choice?.delta?.tool_calls ?? []) {
              const index = delta.index ?? 0;
              const current = partialCalls.get(index) ?? {
                id: "",
                name: "",
                rawArgs: "",
              };

              if (delta.id) current.id = delta.id;
              if (delta.function?.name)
                current.name += delta.function.name;
              if (delta.function?.arguments)
                current.rawArgs += delta.function.arguments;

              partialCalls.set(index, current);
            }

            if (json.usage) usage = this.mapUsage(json.usage);
          } catch {
            // Ignorar errores de parseo en chunks parciales
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [...partialCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, partial]) => {
        const { args, parseError } = parseArguments(partial.rawArgs);
        const call: ToolCall = {
          id: partial.id || `toolCall${index}`,
          name: partial.name,
          args,
          rawArgs: partial.rawArgs,
        };

        if (parseError) call.parseError = parseError;

        return call;
      });

    const effectiveFinishReason: FinishReason = toolCalls.length
      ? "toolCalls"
      : mapFinishReason(finishReason);

    const turn: AssistantTurn = {
      text: fullAssistantResponse,
      toolCalls,
      finishReason: effectiveFinishReason,
    };

if (fullReasoning) turn.reasoning = fullReasoning;

    if (this.normalizeTextToolCalls) {
      const normalized = normalizeToolMarkup(turn);
      if (normalized !== turn) {
        logger.debug("Normalized tool calls emitted as text markup");
        return { turn: normalized, usage };
      }
    }

    for (const call of turn.toolCalls) {
    onEvent?.({ type: "toolCallEnd", id: call.id, name: call.name });
    }

    return { turn, usage };
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

  // Transport primitive: sends the given messages (no history mutation) and
  // returns the assistant turn with tool calls already mapped to the domain.
  async chat(messages: History[], options: ChatOptions = {}): Promise<ChatResult> {
    const model = this.assertReady();

    const response = (await this._fetcher(
      "/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: model.id,
          messages: this.toWireMessages(messages),
          stream: true,
          stream_options: { include_usage: true },
          ...(options.tools?.length
            ? { tools: options.tools.map((tool) => this.toWireToolSpec(tool)) }
            : {}),
        }),
      },
      true,
    )) as Response;
    const { turn, usage } = await this._handleStream(
    response,
    options.onEvent,
  );

    this.lastContextTokens = usage
      ? usage.promptTokens + usage.completionTokens
      : this.estimateHistoryTokens(messages);

    return { turn, usage, costUsd: usage ? this.costOf(usage) : undefined };
  }

  protected assertReady(): Model {
    if (!this.models.length) throw new Error(Errors.NO_LIST_INITIALIZATED);
    const model = this.finModel(this.model);

    if (!model) throw new Error(Errors.MODEL_NOT_FOUND);
    if (!model.capabilities.streaming)
      throw new Error(Errors.MISSING_CAPABILITIES + "streaming");

    return model;
  }

  protected toWireMessages(messages: History[]): OpenAIChatMessage[] {
    return messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: this.format(message.content),
        };
      }

      const wire: OpenAIChatMessage = {
        role: message.role,
        content: this.format(message.content),
      };

      if (message.role === "assistant" && message.toolCalls?.length) {
        wire.tool_calls = message.toolCalls.map((call) =>
          this.toWireToolCall(call),
        );
      }

      return wire;
    });
  }

  protected toWireToolCall(call: ToolCall): OpenAIToolCallPayload {
    return {
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.rawArgs ?? JSON.stringify(call.args ?? {}),
      },
    };
  }

  protected toWireToolSpec(tool: ToolSpec): OpenAIToolSpec {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }

  protected estimateHistoryTokens(messages: History[]) {
    const characters = messages.reduce(
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
    return this.lastContextTokens;
  }

  resetContextUsage() {
    this.lastContextTokens = 0;
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
