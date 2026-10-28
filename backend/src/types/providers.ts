// TODO: extends data to show
//
export type Model = { name: string; id: string };
type AgentResponse = { text: string };
export type History = { role: "system" | "user"; content: string };

export type Provider = {
  url: string;
  history: History[];
  ask: (input: string) => AgentResponse;
  compact: (compactThreshold: number) => History[];
  // models functions
  getAvailableModels: () => Promise<Model[]>;
  setModel: (model: string) => boolean;
  getModel: () => string;
  listModels?: () => Model[];
};
