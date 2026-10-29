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

export type Model = { name: string; id: string; capabilities: Capabilities };
type AgentResponse = {
  text: string;
  images?: { url: string }[];
};
export type History = { role: "system" | "user"; content: string };

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
};
