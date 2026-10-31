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
export type History = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Provider = {
  url: string;
  history: History[];
  initialize: () => Promise<void>;
  ask: (input: string) => Promise<AgentResponse>;
  generateImage: (input: string) => Promise<AgentResponse>;

  compact: (compactThreshold?: number) => History[];
  // models functions
  getAvailableModels: () => Promise<Model[]>;
  setModel: (model: string) => boolean;
  getModel: () => string;
  listModels?: () => Model[];
  getContextWindow: () => number | undefined;
  getContextTokens: () => number;
};
