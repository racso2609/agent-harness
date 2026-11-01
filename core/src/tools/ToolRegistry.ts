import type { ToolCall, ToolResult, ToolSpec } from "@/types/providers";
import type { Tool, ToolContext } from "./Tool";

interface ToolRegistryOptions {
  // Hard cap applied to every tool output before it enters the history.
  maxOutputBytes?: number;
}

class ToolRegistry {
  protected tools = new Map<string, Tool>();
  protected maxOutputBytes: number;

  constructor(tools: Tool[] = [], options: ToolRegistryOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? 32_768;
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool) {
    if (!tool.name) throw new Error("Tool name is required");
    this.tools.set(tool.name, tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  // Specs sent to the model; never includes the implementation.
  specs(): ToolSpec[] {
    return this.list().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  // Dispatches a call. Never throws: failures become tool results so the
  // model can see them and self-correct on the next iteration.
  async execute(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    if (call.parseError) {
      return { output: call.parseError, isError: true };
    }

    const tool = this.tools.get(call.name);
    if (!tool) {
      return { output: `Unknown tool: ${call.name}`, isError: true };
    }

    try {
      return this.truncate(await tool.execute(ctx, call.args));
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  protected truncate(result: ToolResult): ToolResult {
    if (Buffer.byteLength(result.output, "utf8") <= this.maxOutputBytes) {
      return result;
    }

    const sliced = Buffer.from(result.output, "utf8")
      .subarray(0, this.maxOutputBytes)
      .toString("utf8");

    return { ...result, output: `${sliced}\n[output truncated]` };
  }
}

export { ToolRegistry };
export type { ToolRegistryOptions };
