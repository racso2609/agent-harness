import { describe, expect, it } from "vitest";
import type { MemoryHit } from "../../src/memory";
import { RecallTool } from "../../src/tools/recall";
import type { ToolContext } from "../../src/tools/Tool";

const makeCtx = (recallMemory?: (query: string, limit?: number) => Promise<MemoryHit[]>) =>
  ({
    cwd: process.cwd(),
    sessionId: "session",
    approve: async () => "allow",
    ...(recallMemory ? { recallMemory } : {}),
  }) as ToolContext;

const hit = (overrides: Partial<MemoryHit> = {}): MemoryHit => ({
  id: "42",
  kind: "fact",
  scope: "project",
  title: "Deploy host",
  content: "The deploy runs on neon.",
  ...overrides,
});

describe("RecallTool", () => {
  it("prints the id of every hit, so forget has something to take", async () => {
    const tool = new RecallTool();

    const result = await tool.execute(
      makeCtx(async () => [hit()]),
      { query: "deploy" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("#42");
    expect(result.output).toContain("- [fact] #42 **Deploy host**");
    expect(result.output).toContain("The deploy runs on neon.");
  });

  it("formats a hit with no id without breaking the line", async () => {
    const tool = new RecallTool();
    // A backend that reports no id: `id` is typed as required, so the hit is
    // built here instead of destructured.
    const anonymous: MemoryHit = {
      kind: "fact",
      scope: "project",
      title: "Deploy host",
      content: "The deploy runs on neon.",
      id: "",
    };

    const result = await tool.execute(
      makeCtx(async () => [anonymous]),
      { query: "deploy" },
    );

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain("- [fact] **Deploy host**");
    expect(result.output).not.toContain("#undefined");
    expect(result.output).not.toContain("#");
  });

  it("reports an empty query as an error without calling the callback", async () => {
    let called = false;
    const tool = new RecallTool();

    const result = await tool.execute(
      makeCtx(async () => {
        called = true;

        return [];
      }),
      { query: "  " },
    );

    expect(result.isError).toBe(true);
    expect(called).toBe(false);
  });

  it("passthrough the limit and reports no results plainly", async () => {
    const limits: (number | undefined)[] = [];
    const tool = new RecallTool();

    const result = await tool.execute(
      makeCtx(async (_query, limit) => {
        limits.push(limit);

        return [];
      }),
      { query: "deploy", limit: 3 },
    );

    expect(limits).toEqual([3]);
    expect(result.output).toBe('No memories found for: "deploy"');
  });

  it("reports an unusable session when the callback is missing", async () => {
    const tool = new RecallTool();

    const result = await tool.execute(makeCtx(), { query: "deploy" });

    expect(result.isError).toBe(true);
    expect(result.output).toBe("Memory is not available in this session");
  });
});
