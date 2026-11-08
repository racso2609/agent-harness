import type { ToolCall, ToolResult, ToolSpec } from "@/types/providers";
import type { Tool, ToolContext } from "./Tool";

interface ToolRegistryOptions {
  // Hard cap applied to every tool output before it enters the history.
  maxOutputBytes?: number;
}

// Supplies tools that are not known when the registry is built. Called on every
// lookup, so a tool that appears later (an MCP server that was still starting)
// is found without rebuilding the registry.
type ToolProvider = () => Tool[];

class ToolRegistry {
  protected tools = new Map<string, Tool>();

  protected providers: ToolProvider[] = [];

  protected maxOutputBytes: number;

  constructor(tools: Tool[] = [], options: ToolRegistryOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? 32_768;
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool) {
    if (!tool.name) throw new Error("Tool name is required");
    this.tools.set(tool.name, tool);
  }

  // Adds a source of tools resolved at lookup time. Registered tools always win a
  // name clash, and so does the first provider that offers a name: a provider
  // cannot shadow a tool the caller registered explicitly.
  addProvider(provider: ToolProvider) {
    this.providers.push(provider);
  }

  get(name: string) {
    return this.tools.get(name) ?? this.dynamic().find((tool) => tool.name === name);
  }

  list(): Tool[] {
    return [...this.tools.values(), ...this.dynamic()];
  }

  // Specs sent to the model; never includes the implementation.
  specs(): ToolSpec[] {
    return this.list().map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  // Dispatches a call. Never throws: failures become tool results so the model
  // can see them and self-correct on the next iteration.
  async execute(ctx: ToolContext, call: ToolCall): Promise<ToolResult> {
    if (call.parseError) {
      return { output: call.parseError, isError: true };
    }

    const tool = this.get(call.name);
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

  // Tools offered by the providers, minus the registered ones and minus the
  // duplicates a later provider repeats. Recomputed on every call: a provider is
  // free to return a different set each time.
  protected dynamic(): Tool[] {
    if (this.providers.length === 0) return [];

    const seen = new Set(this.tools.keys());
    const tools: Tool[] = [];

    for (const provider of this.providers) {
      for (const tool of provider()) {
        if (seen.has(tool.name)) continue;

        seen.add(tool.name);
        tools.push(tool);
      }
    }

    return tools;
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
export type { ToolProvider, ToolRegistryOptions };
