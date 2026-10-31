export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  agentId?: string;
  messageCount: number;
  // First user message, trimmed for the session list.
  title?: string;
}

export interface SessionStatus {
  sessionId: string;
  agent?: string;
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
