import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool";

const resolvePath = (ctx: ToolContext, raw: string) =>
  path.isAbsolute(raw) ? raw : path.resolve(ctx.cwd, raw);

class WriteFileTool implements Tool {
  name = "writeFile";
  description = "Write UTF-8 text to a file, creating parent directories.";
  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "File path, absolute or relative to the workspace.",
      },
      content: {
        type: "string" as const,
        description: "Full file content to write.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as
      | { path?: unknown; content?: unknown }
      | null
      | undefined;

    if (typeof input?.path !== "string" || !input.path.trim()) {
      throw new Error("writeFile expects a non-empty 'path' string");
    }
    if (typeof input.content !== "string") {
      throw new Error("writeFile expects a 'content' string");
    }

    const filePath = resolvePath(ctx, input.path);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.content, "utf8");

    return {
      output: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${filePath}`,
    };
  }
}

export { WriteFileTool };
