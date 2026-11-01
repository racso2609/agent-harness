import type { Tool, ToolContext, ToolResult } from "./Tool";

// Launches a background child agent. Non-blocking: returns the spawn id
// immediately; the child's final answer is surfaced to this session as a
// system message on a later turn.
class SpawnTool implements Tool {
  name = "spawn";
  description =
    "Delegate a task to a background agent. Launches the agent on its own " +
    "isolated session and returns a spawn id immediately; the agent's final " +
    "answer arrives later as a system message. Use it to parallelize or to " +
    "hand work to a specialized agent (e.g. senior-architect, coder, " +
    "code-reviewer).";
  parameters = {
    type: "object" as const,
    properties: {
      agent: {
        type: "string" as const,
        description: "Id of the agent to run (see the available agents).",
      },
      prompt: {
        type: "string" as const,
        description:
          "Self-contained task for the child. It has no access to this " +
          "conversation, so include every detail it needs.",
      },
      context: {
        type: "string" as const,
        description:
          "Optional context prepended to the prompt (files, constraints, " +
          "prior decisions).",
      },
    },
    required: ["agent", "prompt"],
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as
      | { agent?: unknown; prompt?: unknown; context?: unknown }
      | null
      | undefined;

    if (typeof input?.agent !== "string" || !input.agent.trim()) {
      throw new Error("spawn expects 'agent' to be a non-empty string");
    }
    if (typeof input?.prompt !== "string" || !input.prompt.trim()) {
      throw new Error("spawn expects 'prompt' to be a non-empty string");
    }
    if (input.context !== undefined && typeof input.context !== "string") {
      throw new Error("spawn expects 'context' to be a string when provided");
    }

    if (!ctx.spawn) {
      return {
        output: "Spawning is not available in this session",
        isError: true,
      };
    }

    const agent = input.agent.trim();
    const decision = await ctx.approve({
      tool: this.name,
      kind: "exec",
      subject: `${agent}: ${input.prompt.slice(0, 80)}`,
    });
    if (decision === "deny") {
      return { output: `Spawn of ${agent} rejected by the user`, isError: true };
    }

    try {
      const prompt = input.context
        ? `${input.context}\n\n${input.prompt}`
        : input.prompt;
      const { spawnId } = ctx.spawn(agent, prompt);
      return {
        output:
          `Spawned ${agent} as ${spawnId}. It runs in the background; its ` +
          `final answer will arrive as a system message.`,
      };
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }
}

export { SpawnTool };
