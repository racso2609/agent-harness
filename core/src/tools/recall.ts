import type { Tool, ToolContext, ToolResult } from "./Tool";

// Searches the persistent memory kept from previous sessions. The memory
// context injected at start-up is a summary; this tool is how the model digs
// for a specific fact it suspects is written down somewhere.
class RecallTool implements Tool {
  name = "recall";
  description =
    "Search the persistent project memory captured in previous sessions. Call it when you suspect a decision, fact or past episode is already recorded instead of asking the user again. Each result carries its id (#42), which is what the forget tool takes.";
  parameters = {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "What to look for, in natural language or keywords.",
      },
      limit: {
        type: "number" as const,
        description: "Maximum number of memories to return.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { query?: unknown; limit?: unknown } | null | undefined;
    if (typeof input?.query !== "string" || !input.query.trim()) {
      return {
        output: "recall expects a non-empty 'query' string",
        isError: true,
      };
    }

    if (!ctx.recallMemory) {
      return {
        output: "Memory is not available in this session",
        isError: true,
      };
    }

    const query = input.query.trim();
    const limit = typeof input.limit === "number" && input.limit > 0 ? input.limit : undefined;

    try {
      const hits = await ctx.recallMemory(query, limit);
      if (!hits.length) return { output: `No memories found for: "${query}"` };

      // The id is printed because it is the only handle forget accepts: a result
      // the model cannot name is a memory it cannot ask to delete. A backend that
      // reports no id still lists the line; it just cannot be forgotten by it.
      const lines = hits.map((hit) =>
        hit.id
          ? `- [${hit.kind}] #${hit.id} **${hit.title}**\n ${hit.content}`
          : `- [${hit.kind}] **${hit.title}**\n ${hit.content}`,
      );

      return { output: `Memories for "${query}":\n${lines.join("\n")}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      return { output: `recall failed: ${detail}`, isError: true };
    }
  }
}

export { RecallTool };
