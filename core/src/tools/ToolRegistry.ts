import type { ToolCall, ToolResult, ToolSpec } from "@/types/providers";
import { logger } from "@/utils/logger";
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

  // Names already reported as duplicated by a provider, and providers already
  // reported as throwing: one warning per name, one per provider, however many
  // lookups follow.
  private warnedDuplicates = new Set<string>();

  private brokenProviders = new Set<ToolProvider>();

  protected maxOutputBytes: number;

  constructor(tools: Tool[] = [], options: ToolRegistryOptions = {}) {
    this.maxOutputBytes = options.maxOutputBytes ?? 32_768;
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool) {
    if (!tool.name) throw new Error("Tool name is required");
    this.tools.set(tool.name, tool);
  }

  // Adds a source of tools resolved at lookup time. A provider cannot shadow a
  // tool the caller registered: that precedence is enforced in `dynamic()`, on
  // every lookup, so it also holds for a tool registered after this call.
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
  //
  // Precedence, in this order: a registered tool, then the first provider that
  // offers a name, then any later provider repeating it, which is dropped with a
  // warning.
  //
  // A provider that throws is left out of this lookup and logged instead of
  // propagating: these methods run inside the agent loop, and one broken source
  // of tools must not cost the turn.
  protected dynamic(): Tool[] {
    if (this.providers.length === 0) return [];

    const registered = new Set(this.tools.keys());
    const seen = new Set(registered);
    const tools: Tool[] = [];
    for (const provider of this.providers) {
      let offered: Tool[];
      try {
        offered = provider();
      } catch (err) {
        if (!this.brokenProviders.has(provider)) {
          this.brokenProviders.add(provider);
          logger.warn(`Tool provider failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        continue;
      }

      for (const tool of offered) {
        if (seen.has(tool.name)) {
          // A registered tool taking the name is the documented precedence, not a
          // defect: only real duplicates are worth a warning.
          if (!registered.has(tool.name) && !this.warnedDuplicates.has(tool.name)) {
            this.warnedDuplicates.add(tool.name);
            logger.warn(
              `Tool provider offered a duplicate tool "${tool.name}"; keeping the first one`,
            );
          }

          continue;
        }

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
