export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionStatus {
  sessionId: string;
  provider?: string;
  model?: string;
  usage: SessionUsage;
  costUsd: number;
  contextTokens: number;
  contextWindow?: number;
  contextUsage: number;
  autoCompact: boolean;
  autoCompactThreshold: number;
}
