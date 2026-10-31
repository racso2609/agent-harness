import type { JsonSchema, ToolResult } from "@/types/providers";

// Runtime dependencies handed to a tool on every execution.
export interface ToolContext {
  // Working directory used to resolve relative paths.
  cwd: string;
  // Session that triggered the call, useful for logging/telemetry.
  sessionId: string;
  // Aborted when the turn is cancelled.
  signal?: AbortSignal;
  // Gate for side effects. Returns false when the user rejects the action.
  approve: (command: string) => Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
}

export type { ToolResult };
