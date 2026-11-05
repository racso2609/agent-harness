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

// `cwd` is optional because callers without session context (previews, tests,
// standalone composition) must keep the prompt they always got: without a
// working directory the prompt is not broken, only less informative, and
// omitting it keeps the output byte-identical to the historical text.
export const composeSystemPrompt = (agent: AgentDefinition, skillIndex?: string, cwd?: string) => {
  const base = [HARNESS_SYSTEM_PROMPT, agent.personality]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

  // The tools resolve relative paths against this very directory, so the agent
  // has to be told where it is; otherwise it guesses and edits the wrong place.
  const directory = cwd?.trim();
  const body = directory ? [base, `Working directory: ${directory}`].join("\n\n") : base;

  // Without skills the prompt stays byte-identical to older versions, so
  // sessions without a skill directory keep the exact same context.
  const index = skillIndex?.trim();
  if (!index) return body;

  return [body, `## Skills`, `Load with use_skill(id) when the task matches:`, index].join("\n\n");
};

const APPROVAL_STRICTNESS: Record<AgentApproval, number> = {
  auto: 0,
  ask: 1,
  deny: 2,
};

// Combines two approval policies, keeping the stricter one.
export const strictestApproval = (left: AgentApproval, right: AgentApproval): AgentApproval =>
  APPROVAL_STRICTNESS[right] > APPROVAL_STRICTNESS[left] ? right : left;
