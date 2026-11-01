import { describe, expect, it, vi } from "vitest";
import { SpawnTool } from "../../src/tools/spawn";
import type { ToolContext } from "../../src/tools/Tool";

const makeContext = (spawn?: ToolContext["spawn"]): ToolContext => ({
  cwd: "/workspace",
  sessionId: "session-1",
  approve: async () => "allow",
  spawn,
});

describe("SpawnTool", () => {
  it("spawns an agent and returns a spawn id without waiting", async () => {
    const spawn = vi.fn(() => ({ spawnId: "spawn-1", agentId: "coder" }));
    const tool = new SpawnTool();

    const result = await tool.execute(makeContext(spawn), {
      agent: "coder",
      prompt: "do the thing",
    });

    expect(spawn).toHaveBeenCalledWith("coder", "do the thing");
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("spawn-1");
    expect(result.output).toContain("coder");
  });

  it("prepends context to the prompt when provided", async () => {
    const spawn = vi.fn(() => ({ spawnId: "spawn-1", agentId: "coder" }));
    const tool = new SpawnTool();

    await tool.execute(makeContext(spawn), {
      agent: "coder",
      prompt: "the task",
      context: "shared ctx",
    });

    expect(spawn).toHaveBeenCalledWith("coder", "shared ctx\n\nthe task");
  });

  it("goes through the approval gate and stops on deny", async () => {
    const spawn = vi.fn();
    const approve = vi.fn(async () => "deny" as const);
    const tool = new SpawnTool();

    const result = await tool.execute(
      { ...makeContext(spawn), approve },
      { agent: "coder", prompt: "task" },
    );

    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "spawn", kind: "exec" }),
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/rejected/);
  });

  it("rejects missing or non-string arguments", async () => {
    const tool = new SpawnTool();
    const ctx = makeContext(vi.fn());

    await expect(tool.execute(ctx, { prompt: "x" })).rejects.toThrow(/agent/);
    await expect(tool.execute(ctx, { agent: "coder" })).rejects.toThrow(
      /prompt/,
    );
    await expect(
      tool.execute(ctx, { agent: "coder", prompt: "x", context: 42 }),
    ).rejects.toThrow(/context/);
  });

  it("reports an error when spawning is unavailable", async () => {
    const tool = new SpawnTool();

    const result = await tool.execute(makeContext(undefined), {
      agent: "coder",
      prompt: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/not available/);
  });

  it("surfaces spawn failures as a tool error", async () => {
    const spawn = vi.fn(() => {
      throw new Error("Spawning is disabled");
    });
    const tool = new SpawnTool();

    const result = await tool.execute(makeContext(spawn), {
      agent: "coder",
      prompt: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("Spawning is disabled");
  });
});
