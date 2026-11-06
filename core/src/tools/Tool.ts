import type { MemoryHit } from "@/memory";
import type { JsonSchema, ToolResult } from "@/types/providers";

// What a tool is about to do, handed to the approval gate.
export interface ApprovalRequest {
  // Tool being executed (e.g. "shell", "writeFile").
  tool: string;
  // Side-effect class of the action.
  kind: "read" | "write" | "exec";
  // Human-readable subject: the command, the path, ...
  subject: string;
}

// Outcome of an approval request. "always" allows the subject for the rest
// of the session without prompting again.
export type ApprovalDecision = "allow" | "deny" | "always";

// Runtime dependencies handed to a tool on every execution.
export interface ToolContext {
  // Working directory used to resolve relative paths.
  cwd: string;
  // Session that triggered the call, useful for logging/telemetry.
  sessionId: string;
  // Aborted when the turn is cancelled.
  signal?: AbortSignal;
  // Gate for side effects. Returns the decision for the requested action.
  approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  // Launches a background child agent from the spawning session. Injected by
  // the session manager; tools that cannot spawn leave it undefined.
  spawn?: (agentId: string, prompt: string) => SpawnRequestResult;
  // Returns the body of a loaded skill, undefined when unknown.
  getSkillBody?: (id: string) => string | undefined;
  // Lists the ids of the loaded skills, for error messages.
  listSkillIds?: () => string[];
  // Searches the persistent memory. Injected by the session manager; tools
  // that cannot recall leave it undefined.
  recallMemory?: (query: string, limit?: number) => Promise<MemoryHit[]>;
  // Live output of a long-running tool. Chunks are already throttled by the
  // tool. Optional: every tool must work without it.
  onOutput?: (chunk: string) => void;
}

// Outcome of a spawn request made through the tool context.
export interface SpawnRequestResult {
  spawnId: string;
  agentId: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (ctx: ToolContext, args: unknown) => Promise<ToolResult>;
}

export type { ToolResult };
