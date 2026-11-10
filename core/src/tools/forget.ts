import type { Tool, ToolContext, ToolResult } from "./Tool";

// Ids are whatever the backend hands back in a hit: the local one is a SQLite
// integer and Engram's is numeric too. Anything else is a hallucinated id, so
// it is rejected before it reaches the provider. The leading digit is 1..9
// because no backend hands out 0: SQLite rowids and every count-based id start
// at one, so "0" is a guess, not an id.
const ID_PATTERN = /^[1-9][0-9]*$/;

// Deletes a memory the user considers wrong or obsolete. Deletion is the one
// memory operation that cannot be undone, so the session gates it through the
// approval policy and the tool only reports what happened.
class ForgetTool implements Tool {
  name = "forget";
  description =
    "Delete one stored memory by id. Use it when the user asks you to forget something, or when a memory is wrong and would keep misguiding future sessions. The id is the one returned by recall, listMemories or the remember tool; never invent one.";
  parameters = {
    type: "object" as const,
    properties: {
      id: {
        type: "string" as const,
        description: "Id of the memory to delete, taken from a recall or listMemories result.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { id?: unknown } | null | undefined;
    if (typeof input?.id !== "string" || !input.id.trim()) {
      return {
        output: "forget expects a non-empty 'id' string",
        isError: true,
      };
    }

    const id = input.id.trim();
    if (!ID_PATTERN.test(id)) {
      return {
        output: `forget expects a numeric id like "42", got "${id}". Search with recall or listMemories first.`,
        isError: true,
      };
    }

    if (!ctx.forgetMemory) {
      return {
        output: "Memory is not available in this session",
        isError: true,
      };
    }

    try {
      // The session re-checks the scope of the stored entry and asks for approval;
      // the scope passed here is only the default the contract documents.
      const result = await ctx.forgetMemory(id, "project");

      switch (result.reason) {
        case "ok":
          return { output: `Forgot memory ${id}.` };
        case "not-found":
          return {
            output: `No memory with id ${id}. Check the id with recall or listMemories.`,
            isError: true,
          };
        case "out-of-scope":
          return {
            output: `Memory ${id} belongs to another session or project, so it cannot be deleted from here.`,
            isError: true,
          };
        case "unsupported":
          return {
            output:
              "Memory is not available in this session: the configured backend cannot delete memories",
            isError: true,
          };
        default:
          return { output: `forget failed for memory ${id}`, isError: true };
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      return { output: `forget failed: ${detail}`, isError: true };
    }
  }
}

export { ForgetTool };
