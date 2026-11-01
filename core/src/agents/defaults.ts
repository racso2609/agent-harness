import type { AgentApproval, AgentDefinition } from "./AgentDefinition";

export const DEFAULT_AGENT_ID = "default";

export const HARNESS_SYSTEM_PROMPT =
  "You are running inside a terminal agent harness. Be concise and precise, use the available tools when they help, and report results clearly.";

export const builtInDefaultAgent = (): AgentDefinition => ({
  id: DEFAULT_AGENT_ID,
  name: "Default",
  description: "General-purpose coding assistant",
  personality:
    "You are a helpful coding assistant. Explain decisions when useful and prefer minimal, correct changes.",
});

export const composeSystemPrompt = (agent: AgentDefinition) =>
  [HARNESS_SYSTEM_PROMPT, agent.personality]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

const APPROVAL_STRICTNESS: Record<AgentApproval, number> = {
  auto: 0,
  ask: 1,
  deny: 2,
};

// Combines two approval policies, keeping the stricter one.
export const strictestApproval = (
  left: AgentApproval,
  right: AgentApproval,
): AgentApproval =>
  APPROVAL_STRICTNESS[right] > APPROVAL_STRICTNESS[left] ? right : left;