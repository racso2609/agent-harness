import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolResult } from "./Tool";
import { resolveInWorkspace } from "./paths";

class ListDirTool implements Tool {
  name = "listDir";
  description =
    "List the entries of a directory. Directories are suffixed with '/'.";
  parameters = {
    type: "object" as const,
    properties: {
      path: {
        type: "string" as const,
        description: "Directory path; defaults to the workspace root.",
      },
    },
    additionalProperties: false,
  };

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { path?: unknown } | null | undefined;
    if (input?.path !== undefined && typeof input.path !== "string") {
      throw new Error("listDir expects 'path' to be a string");
    }

    const target = resolveInWorkspace(ctx.cwd, input?.path ?? ".");
    const entries = await fs.readdir(target, { withFileTypes: true });
    const lines = entries
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort((left, right) => left.localeCompare(right));

    return {
      output: lines.length
        ? `${target}:\n${lines.join("\n")}`
        : `${target}: (empty)`,
    };
  }
}

export { ListDirTool };
