export type AgentApproval = "ask" | "auto" | "deny";

export interface AgentDefinition {
  // Canonical id, derived from the file name (or "default" when embedded).
  id: string;
  // Human-readable name shown in listings.
  name: string;
  description?: string;
  // Body of the markdown file: the agent personality / system prompt.
  personality: string;
  // Optional provider/model overrides; inherited from config when absent.
  provider?: string;
  model?: string;
  // Tool allowlist. Undefined inherits every enabled tool; [] disables tools.
  tools?: string[];
  // Approval policy; may only tighten the configured global policy.
  approval?: AgentApproval;
  // Tool-loop cap; may only lower the configured global cap.
  maxIterations?: number;
  // Origin file, useful for diagnostics.
  source?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description?: string;
}