import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./Tool";
import { resolveInWorkspace } from "./paths";

interface WriteFileOptions {
  // Extra glob-ish patterns (relative to the workspace) that cannot be
  // written. Supports a single `*` wildcard and a trailing `/` for dirs.
  deny?: string[];
}

// Patterns that are always refused: repository internals and secrets.
const DEFAULT_DENY = [".git/", ".git"];

const toRegExp = (pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
};

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

  protected deny: string[];

  constructor(options: WriteFileOptions = {}) {
    this.deny = [...DEFAULT_DENY, ...(options.deny ?? [])];
  }

  async execute(ctx: ToolContext, args: unknown): Promise<ToolResult> {
    const input = args as { path?: unknown; content?: unknown } | null | undefined;

    if (typeof input?.path !== "string" || !input.path.trim()) {
      throw new Error("writeFile expects a non-empty 'path' string");
    }
    if (typeof input.content !== "string") {
      throw new Error("writeFile expects a 'content' string");
    }

    const filePath = resolveInWorkspace(ctx.cwd, input.path);
    if (this.isDenied(ctx.cwd, filePath)) {
      throw new Error(`Refusing to write denied path: ${input.path}`);
    }

    const decision = await ctx.approve({
      tool: this.name,
      kind: "write",
      subject: filePath,
    });
    if (decision === "deny") {
      return { output: `Write rejected by the user: ${input.path}`, isError: true };
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.content, "utf8");

    return {
      output: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${filePath}`,
    };
  }

  // Matches the workspace-relative path against the deny patterns, both as
  // the file itself and as every directory prefix (so ".git/" also blocks
  // ".git/config").
  protected isDenied(workspace: string, filePath: string) {
    const relative = path.relative(path.resolve(workspace), filePath).split(path.sep).join("/");

    const parts = relative.split("/");
    const candidates = parts.map((_, index) =>
      index === parts.length - 1 ? relative : `${parts.slice(0, index + 1).join("/")}/`,
    );
    candidates.push(relative);

    return this.deny.some((pattern) => {
      const regex = toRegExp(pattern);
      return candidates.some((candidate) => regex.test(candidate));
    });
  }
}

export { WriteFileTool };
export type { WriteFileOptions };
