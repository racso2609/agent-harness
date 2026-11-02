import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/tools/ToolRegistry";
import type { Tool, ToolContext } from "../../src/tools/Tool";

const ctx: ToolContext = {
  cwd: process.cwd(),
  sessionId: "session",
  approve: async () => "allow",
};

const makeTool = (overrides: Partial<Tool> = {}): Tool => ({
  name: "echo",
  description: "Echo a value",
  parameters: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  execute: vi.fn(async (_ctx, args) => ({
    output: JSON.stringify(args),
  })),
  ...overrides,
});

describe("ToolRegistry", () => {
  it("exposes specs without the implementation", () => {
    const registry = new ToolRegistry([makeTool()]);

    expect(registry.specs()).toEqual([
      {
        name: "echo",
        description: "Echo a value",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ]);
  });

  it("dispatches args to the matching tool", async () => {
    const tool = makeTool();
    const registry = new ToolRegistry([tool]);

    const result = await registry.execute(ctx, {
      id: "call_1",
      name: "echo",
      args: { value: "hi" },
    });

    expect(tool.execute).toHaveBeenCalledWith(ctx, { value: "hi" });
    expect(result).toEqual({ output: '{"value":"hi"}' });
  });

  it("returns an error result for unknown tools", async () => {
    const registry = new ToolRegistry([makeTool()]);

    await expect(
      registry.execute(ctx, { id: "call_1", name: "missing", args: {} }),
    ).resolves.toEqual({
      output: "Unknown tool: missing",
      isError: true,
    });
  });

  it("returns an error result for unparsable arguments", async () => {
    const registry = new ToolRegistry([makeTool()]);

    await expect(
      registry.execute(ctx, {
        id: "call_1",
        name: "echo",
        args: undefined,
        parseError: "Tool arguments are not valid JSON",
      }),
    ).resolves.toEqual({
      output: "Tool arguments are not valid JSON",
      isError: true,
    });
  });

  it("converts thrown errors into tool results", async () => {
    const registry = new ToolRegistry([
      makeTool({
        execute: async () => {
          throw new Error("boom");
        },
      }),
    ]);

    await expect(registry.execute(ctx, { id: "call_1", name: "echo", args: {} })).resolves.toEqual({
      output: "boom",
      isError: true,
    });
  });

  it("truncates outputs larger than the configured limit", async () => {
    const registry = new ToolRegistry(
      [makeTool({ execute: async () => ({ output: "x".repeat(100) }) })],
      { maxOutputBytes: 10 },
    );

    const result = await registry.execute(ctx, {
      id: "call_1",
      name: "echo",
      args: {},
    });

    expect(result.output).toBe(`${"x".repeat(10)}\n[output truncated]`);
  });
});
