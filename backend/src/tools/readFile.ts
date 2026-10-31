import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool";
import { resolveInWorkspace } from "./paths";

const MAX_BYTES = 32_768;

class ReadFileTool implements Tool {
  name = "readFile";
  description = "Read a UTF-8 text file from the workspace.";
  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path, absolute or relative to the workspace.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { path?: unknown } | null | undefined;
    if (typeof input?.path !== "string" || !input.path.trim()) {
      throw new Error("readFile expects a non-empty 'path' string");
    }

    const filePath = resolveInWorkspace(ctx.cwd, input.path);
    const content = await fs.readFile(filePath, "utf8");

    if (Buffer.byteLength(content, "utf8") <= MAX_BYTES) {
      return { output: content };
    }

    const sliced = Buffer.from(content, "utf8")
      .subarray(0, MAX_BYTES)
      .toString("utf8");

    return { output: `${sliced}\n[file truncated]` };
  }
}

export { ReadFileTool };
