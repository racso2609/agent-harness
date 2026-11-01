// TODO: extends data to show
//
interface Capabilities {
  vision: boolean;
  video: boolean;
  reasoning: boolean;
  streaming: boolean;
  image_generation: boolean;
  image_edit: boolean;
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  currency: string;
}

export type Model = {
  name: string;
  id: string;
  capabilities: Capabilities;
  contextLength?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
};
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};
export type AgentResponse = {
  text: string;
  images?: { url: string }[];
  usage?: TokenUsage;
  costUsd?: number;
};

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  items?: JsonSchemaProperty;
  enum?: (string | number | boolean)[];
};

export type JsonSchema = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolSpec = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  rawArgs?: string;
  parseError?: string;
};

export type ToolResult = {
  output: string;
  isError?: boolean;
};

export type FinishReason =
  | "stop"
  | "toolCalls"
  | "length"
  | "contentFilter"
  | "other";

export type AssistantTurn = {
  text: string;
  // Reasoning produced before the answer, when the provider exposes it.
  // Never sent back as conversation history.
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason: FinishReason;
};

// Events emitted while a turn is being produced. The UI consumes them to
// render live progress; consumers that only want the final result ignore them.
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "toolCallStart"; id: string; name: string }
  | { type: "toolCallEnd"; id: string; name: string };

export type ChatEventListener = (event: ChatEvent) => void;

export type ChatOptions = {
  tools?: ToolSpec[];
  // Called as the turn is produced. Optional: omitting it preserves the
  // existing non-streaming behaviour of chat().
  onEvent?: ChatEventListener;
};

export type ChatResult = {
  turn: AssistantTurn;
  usage?: TokenUsage;
  costUsd?: number;
};

export type SystemMessage = { role: "system"; content: string };
export type UserMessage = { role: "user"; content: string };
export type AssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
};
export type ToolMessage = {
  role: "tool";
  content: string;
  toolCallId: string;
};

export type History =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export type Provider = {
  url: string;
  initialize: () => Promise<void>;
  chat: (messages: History[], options?: ChatOptions) => Promise<ChatResult>;
  generateImage: (input: string) => Promise<AgentResponse>;
  // models functions
  getAvailableModels: () => Promise<Model[]>;
  setModel: (model: string) => boolean;
  getModel: () => string;
  listModels?: () => Model[];
  getContextWindow: () => number | undefined;
  getContextTokens: () => number;
  resetContextUsage: () => void;
};
